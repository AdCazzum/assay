import { describe, expect, it } from 'vitest';
import {
  createAssayNode,
  JobNotChallengeableError,
  JobNotSettleableError,
  MissingChallengerAccountError,
  PaymentNotConfirmedError,
  ReputationUpdateFailedError,
  UnknownClaimError,
} from './node.js';
import { PayDeclinedError } from './pay-policy.js';
import { createCapabilityRegistry } from './runtime.js';
import { computeChallengeFailedReputationDelta, computeSlashReputationDelta } from './settlement-policy.js';
import {
  FakeGraphPort,
  FakePaymentsPort,
  FakeRegistryPort,
  type FakePaymentsPortOptions,
} from './test-support/fakes.js';
import type { Capability, Manifest, ProviderRecord, Reputation, Verdict } from './types.js';

const PROVIDER_NAME = 'rugscore.assay.eth';
const CHALLENGER_ACCOUNT_ID = '0.0.999999';

const manifest: Manifest = {
  capabilityId: 'echo',
  description: 'echoes a token back with its length as a fabricated claim, for orchestration tests only',
  priceHbar: 5,
  endpoint: 'https://example.invalid/echo',
  bondRef: 'bond-seed',
  verifierHash: '0xseed',
};

const seedRecord: Omit<ProviderRecord, 'name'> = {
  manifest,
  reputation: { score: 80, jobs: 3, slashes: 0, bondHbar: 50 },
};

type EchoVerify = Capability<string, { echoed: string }>['verify'];

/**
 * A trivial capability whose result carries one block-stamped claim, so the
 * loop test can assert claims survive intact into the job. Not rug-score:
 * core must not know that capability exists. `verify` is injectable so the
 * challenge/settle tests below can drive both a true and a lying verdict
 * without a second capability.
 */
function makeEchoCapability(verify?: EchoVerify): Capability<string, { echoed: string }> {
  return {
    id: 'echo',
    async run(req) {
      return {
        result: { echoed: req },
        claims: [{ k: 'echoedLength', v: req.length, atBlock: 12345 }],
      };
    },
    verify: verify ?? (async () => ({ valid: true })),
  };
}

const echoCapability = makeEchoCapability();

function buildNode(
  paymentsOpts?: FakePaymentsPortOptions,
  reputation: Partial<Reputation> = {},
) {
  const registry = new FakeRegistryPort().seed(PROVIDER_NAME, {
    manifest,
    reputation: { ...seedRecord.reputation, ...reputation },
  });
  const payments = new FakePaymentsPort(paymentsOpts);
  const graph = new FakeGraphPort();
  const capabilities = createCapabilityRegistry();
  capabilities.register(echoCapability);

  const node = createAssayNode({ registry, payments, graph, capabilities });
  return { node, registry, payments, graph, capabilities };
}

/**
 * Builds a node already carrying one served job, ready to be challenged, plus
 * whatever ports the challenge/settle tests need to inspect or fail on
 * purpose (`registry`/`payments` are the real fakes, not stand-ins for
 * `verify()` — that piece is #12's, driven here by `opts.verify`).
 */
async function buildServedNode(
  opts: {
    verify?: EchoVerify;
    reputation?: Partial<Reputation>;
    challengerAccountId?: string | null;
  } = {},
) {
  const registry = new FakeRegistryPort().seed(PROVIDER_NAME, {
    manifest,
    reputation: { ...seedRecord.reputation, ...opts.reputation },
  });
  const payments = new FakePaymentsPort();
  const graph = new FakeGraphPort();
  const capabilities = createCapabilityRegistry();
  capabilities.register(makeEchoCapability(opts.verify));

  const node = createAssayNode({
    registry,
    payments,
    graph,
    capabilities,
    challengerAccountId: opts.challengerAccountId === null ? undefined : (opts.challengerAccountId ?? CHALLENGER_ACCOUNT_ID),
  });

  const { job } = await node.payAndCall(PROVIDER_NAME, 'echo', 'hello');
  return { node, registry, payments, graph, job };
}

describe('createAssayNode', () => {
  it('runs the honest loop end to end: discover, pay, confirm, serve a job in served with block-stamped claims', async () => {
    const { node } = buildNode();

    const discovered = await node.discover(PROVIDER_NAME);
    expect(discovered.manifest.priceHbar).toBe(5);
    expect(discovered.reputation.score).toBe(80);

    const { txId, job } = await node.payAndCall(PROVIDER_NAME, 'echo', 'hello');

    expect(txId).toMatch(/^0xfake-pay-/);
    expect(job.status).toBe('served');
    expect(job.provider).toBe(PROVIDER_NAME);
    expect(job.paymentTx).toBe(txId);
    expect(job.result).toEqual({ echoed: 'hello' });
    expect(job.claims).toEqual([{ k: 'echoedLength', v: 5, atBlock: 12345 }]);

    // the job really landed in the store, not just in the returned value
    expect(node.jobs.get(job.jobId)).toEqual(job);
    expect(node.jobs.list()).toHaveLength(1);
  });

  it('the payment gate: an unconfirmed payment never produces a served result', async () => {
    const { node, payments } = buildNode({ confirmedTxIds: [] });

    await expect(node.payAndCall(PROVIDER_NAME, 'echo', 'hello')).rejects.toThrow(
      PaymentNotConfirmedError,
    );

    expect(node.jobs.list()).toEqual([]);
    // the gate actually consulted confirm(), it didn't just skip payment
    expect(payments.confirmCalls).toHaveLength(1);
    expect(payments.payCalls).toHaveLength(1);
  });

  it('the payment gate: a failed (never-confirming) payment never produces a served result even called directly through serve()', async () => {
    const { node, payments } = buildNode({ confirmedTxIds: [] });
    const { txId } = await payments.pay(5, 'some-request-hash');

    await expect(
      node.serve({ provider: PROVIDER_NAME, capabilityId: 'echo', request: 'hello', txId }),
    ).rejects.toThrow(PaymentNotConfirmedError);

    expect(node.jobs.list()).toEqual([]);
  });

  it('serves once the payment genuinely confirms, not merely because pay() was called', async () => {
    const { node, payments } = buildNode({ confirmedTxIds: [] });
    const { txId } = await payments.pay(5, 'some-request-hash');

    await expect(
      node.serve({ provider: PROVIDER_NAME, capabilityId: 'echo', request: 'hello', txId }),
    ).rejects.toThrow(PaymentNotConfirmedError);

    payments.setConfirmed(txId);
    const job = await node.serve({
      provider: PROVIDER_NAME,
      capabilityId: 'echo',
      request: 'hello',
      txId,
    });

    expect(job.status).toBe('served');
    expect(node.jobs.list()).toHaveLength(1);
  });

  it('discover surfaces manifest and reputation so a requester can decide whether to pay', async () => {
    const { node } = buildNode();

    const record = await node.discover(PROVIDER_NAME);

    expect(record.manifest).toEqual(manifest);
    expect(record.reputation).toEqual({ score: 80, jobs: 3, slashes: 0, bondHbar: 50 });
  });

  it('register publishes the manifest and posts the bond', async () => {
    const { node, registry, payments } = buildNode();

    const result = await node.register({ name: PROVIDER_NAME, manifest, bondHbar: 50 });

    expect(result.manifestTxHash).toMatch(/^0xfake-manifest-/);
    expect(result.bondRef).toMatch(/^fake-bond-/);
    expect(registry.publishedManifests).toEqual([{ name: PROVIDER_NAME, manifest }]);
    expect(payments.postBondCalls).toEqual([50]);
  });

  it('assess() gives discover()\'s record back with a structured risk read, without deciding for the caller', async () => {
    const { node } = buildNode();

    const assessment = await node.assess(PROVIDER_NAME);

    expect(assessment.providerName).toBe(PROVIDER_NAME);
    expect(assessment.jobs).toBe(3);
    expect(assessment.slashes).toBe(0);
    expect(assessment.unproven).toBe(false);
    expect(assessment.signals.length).toBeGreaterThan(0);
  });

  it('payAndCall pays a provider with a clean record and a fair price (the pay policy floor is satisfied)', async () => {
    const { node, payments } = buildNode(undefined, { jobs: 20, slashes: 0, bondHbar: 50 });

    const { job } = await node.payAndCall(PROVIDER_NAME, 'echo', 'hello');

    expect(job.status).toBe('served');
    expect(payments.payCalls).toHaveLength(1);
  });

  it('payAndCall declines a provider with slashes against few jobs, naming the reason, and never pays', async () => {
    const { node, payments } = buildNode(undefined, { jobs: 4, slashes: 2, bondHbar: 50 });

    await expect(node.payAndCall(PROVIDER_NAME, 'echo', 'hello')).rejects.toThrow(PayDeclinedError);

    try {
      await node.payAndCall(PROVIDER_NAME, 'echo', 'hello');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PayDeclinedError);
      const decline = err as PayDeclinedError;
      expect(decline.providerName).toBe(PROVIDER_NAME);
      expect(decline.message).toMatch(/slash/i);
      expect(decline.assessment.slashRatio).toBeCloseTo(0.5);
    }

    // the decline happened before any payment was ever attempted
    expect(payments.payCalls).toHaveLength(0);
    expect(node.jobs.list()).toEqual([]);
  });

  it('payAndCall declines when the bond is far smaller than the price, even with a clean record', async () => {
    const { node, payments } = buildNode(undefined, { jobs: 20, slashes: 0, bondHbar: 1 });

    await expect(node.payAndCall(PROVIDER_NAME, 'echo', 'hello')).rejects.toThrow(PayDeclinedError);
    expect(payments.payCalls).toHaveLength(0);
  });

  it('an unproven (0-job) provider is not silently treated as good: it is distinguishable in the assessment, even though the default policy pays it given a strong bond', async () => {
    const { node } = buildNode(undefined, { jobs: 0, slashes: 0, bondHbar: 50 });

    const assessment = await node.assess(PROVIDER_NAME);
    expect(assessment.unproven).toBe(true);
    expect(assessment.slashRatio).toBeNull();

    const { job } = await node.payAndCall(PROVIDER_NAME, 'echo', 'hello');
    expect(job.status).toBe('served');
  });

  it('an injected payPolicy overrides the default floor', async () => {
    const registry = new FakeRegistryPort().seed(PROVIDER_NAME, {
      manifest,
      reputation: { score: 80, jobs: 100, slashes: 1, bondHbar: 50 },
    });
    const payments = new FakePaymentsPort();
    const graph = new FakeGraphPort();
    const capabilities = createCapabilityRegistry();
    capabilities.register(echoCapability);

    // slash ratio 0.01 passes the default policy (max 0.15) but not a
    // caller-injected, stricter one
    const node = createAssayNode({
      registry,
      payments,
      graph,
      capabilities,
      payPolicy: { maxSlashRatio: 0.005, minBondToPriceRatio: 2 },
    });

    await expect(node.payAndCall(PROVIDER_NAME, 'echo', 'hello')).rejects.toThrow(PayDeclinedError);
  });

});

describe('createAssayNode: challenge (#26)', () => {
  it('routes to the capability\'s verify() with the full claim set and moves served -> challenged, recording the verdict', async () => {
    let calledWith: unknown;
    const verdict: Verdict = { valid: true };
    const { node, job } = await buildServedNode({
      verify: async (req, result, claims) => {
        calledWith = { req, result, claims };
        return verdict;
      },
    });

    const returned = await node.challenge(job.jobId, 'echoedLength');

    expect(returned).toEqual(verdict);
    expect(calledWith).toEqual({ req: 'hello', result: { echoed: 'hello' }, claims: job.claims });

    const updated = node.jobs.get(job.jobId);
    expect(updated.status).toBe('challenged');
    expect(updated.verdict).toEqual(verdict);
  });

  it('rejects an unknown claim key without ever calling verify()', async () => {
    let verifyCalls = 0;
    const { node, job } = await buildServedNode({
      verify: async () => {
        verifyCalls += 1;
        return { valid: true };
      },
    });

    await expect(node.challenge(job.jobId, 'noSuchClaim')).rejects.toThrow(UnknownClaimError);
    expect(verifyCalls).toBe(0);
    expect(node.jobs.get(job.jobId).status).toBe('served');
  });

  it('rejects re-challenging a job that already moved past served, without calling verify() again', async () => {
    let verifyCalls = 0;
    const { node, job } = await buildServedNode({
      verify: async () => {
        verifyCalls += 1;
        return { valid: true };
      },
    });

    await node.challenge(job.jobId, 'echoedLength');
    expect(verifyCalls).toBe(1);

    await expect(node.challenge(job.jobId, 'echoedLength')).rejects.toThrow(JobNotChallengeableError);
    expect(verifyCalls).toBe(1);
  });

  it("propagates the capability's own verify() failure and leaves the job at served, so it stays retryable", async () => {
    const { node, job } = await buildServedNode({
      verify: async () => {
        throw new Error('The Graph is unreachable at this block');
      },
    });

    await expect(node.challenge(job.jobId, 'echoedLength')).rejects.toThrow(/unreachable/);
    expect(node.jobs.get(job.jobId).status).toBe('served');
  });

  it('rejects an unknown job id', async () => {
    const { node } = buildNode();
    await expect(node.challenge('no-such-job', 'echoedLength')).rejects.toThrow(/Unknown job/);
  });
});

describe('createAssayNode: settle (#27)', () => {
  const lieVerdict: Verdict = { valid: false, badClaim: 'echoedLength', reason: 'the length was fabricated' };
  const trueVerdict: Verdict = { valid: true };

  it('an invalid verdict slashes the bond to the challenger and drops the provider\'s ENS reputation, moving the job to slashed', async () => {
    const { node, registry, payments, job } = await buildServedNode({
      verify: async () => lieVerdict,
      reputation: { score: 80, jobs: 3, slashes: 0, bondHbar: 50 },
    });
    const verdict = await node.challenge(job.jobId, 'echoedLength');

    const settled = await node.settle(job.jobId, verdict);

    expect(payments.slashCalls).toEqual([
      { bondRef: manifest.bondRef, toChallenger: CHALLENGER_ACCOUNT_ID },
    ]);
    expect(settled.status).toBe('slashed');
    expect(settled.verdict).toEqual(lieVerdict);

    const expectedDelta = computeSlashReputationDelta({ score: 80, jobs: 3, slashes: 0, bondHbar: 50 });
    const updated = await registry.resolveProvider(PROVIDER_NAME);
    expect(updated.reputation).toEqual({ ...expectedDelta, bondHbar: 50 });
    expect(updated.reputation.score).toBeLessThan(80);
    expect(updated.reputation.slashes).toBe(1);
  });

  it('a valid verdict fails the challenge, raises the provider\'s reputation, and never slashes, moving the job to settled', async () => {
    const { node, registry, payments, job } = await buildServedNode({
      verify: async () => trueVerdict,
      reputation: { score: 80, jobs: 3, slashes: 0, bondHbar: 50 },
    });
    const verdict = await node.challenge(job.jobId, 'echoedLength');

    const settled = await node.settle(job.jobId, verdict);

    expect(payments.slashCalls).toEqual([]);
    expect(settled.status).toBe('settled');
    expect(settled.verdict).toEqual(trueVerdict);

    const expectedDelta = computeChallengeFailedReputationDelta({
      score: 80,
      jobs: 3,
      slashes: 0,
      bondHbar: 50,
    });
    const updated = await registry.resolveProvider(PROVIDER_NAME);
    expect(updated.reputation).toEqual({ ...expectedDelta, slashes: 0, bondHbar: 50 });
    expect(updated.reputation.score).toBeGreaterThan(80);
  });

  it('rejects settling a job that was never challenged (still served)', async () => {
    const { node, job } = await buildServedNode();

    await expect(node.settle(job.jobId, trueVerdict)).rejects.toThrow(JobNotSettleableError);
  });

  it('double-settle is rejected and does not slash twice', async () => {
    const { node, payments, job } = await buildServedNode({ verify: async () => lieVerdict });
    const verdict = await node.challenge(job.jobId, 'echoedLength');

    await node.settle(job.jobId, verdict);
    expect(payments.slashCalls).toHaveLength(1);

    await expect(node.settle(job.jobId, verdict)).rejects.toThrow(JobNotSettleableError);
    expect(payments.slashCalls).toHaveLength(1);
  });

  it('refuses to settle an invalid verdict with no challengerAccountId configured, before ever attempting a slash', async () => {
    const { node, payments, job } = await buildServedNode({
      verify: async () => lieVerdict,
      challengerAccountId: null,
    });
    const verdict = await node.challenge(job.jobId, 'echoedLength');

    await expect(node.settle(job.jobId, verdict)).rejects.toThrow(MissingChallengerAccountError);
    expect(payments.slashCalls).toEqual([]);
    // the job is still challenged, not stuck in some invented state: a retry after configuring
    // challengerAccountId is safe
    expect(node.jobs.get(job.jobId).status).toBe('challenged');
  });

  it('the partial-failure path: the slash lands for real but the ENS reputation write then fails, leaving the job truthfully "slashed" rather than an invented in-between state', async () => {
    const { node, registry, payments, job } = await buildServedNode({ verify: async () => lieVerdict });
    const verdict = await node.challenge(job.jobId, 'echoedLength');
    registry.updateReputationError = new Error('Sepolia RPC timed out');

    await expect(node.settle(job.jobId, verdict)).rejects.toThrow(ReputationUpdateFailedError);

    // the money moved: the slash really happened
    expect(payments.slashCalls).toHaveLength(1);
    // and the job says so honestly, even though the reputation write failed
    expect(node.jobs.get(job.jobId).status).toBe('slashed');
    expect(node.jobs.get(job.jobId).verdict).toEqual(lieVerdict);
  });

  it('when the slash transaction itself fails, nothing is recorded and the job stays challenged, safe to retry', async () => {
    const { node, payments, job } = await buildServedNode({ verify: async () => lieVerdict });
    const verdict = await node.challenge(job.jobId, 'echoedLength');
    payments.slashError = new Error('Hedera testnet is congested');

    await expect(node.settle(job.jobId, verdict)).rejects.toThrow(/congested/);

    expect(node.jobs.get(job.jobId).status).toBe('challenged');

    // and the retry (slashError cleared itself after firing once) succeeds cleanly
    const settled = await node.settle(job.jobId, verdict);
    expect(settled.status).toBe('slashed');
    expect(payments.slashCalls).toHaveLength(2);
  });

  it('rejects an unknown job id', async () => {
    const { node } = buildNode();
    await expect(node.settle('no-such-job', trueVerdict)).rejects.toThrow(/Unknown job/);
  });
});

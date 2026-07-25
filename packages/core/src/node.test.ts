import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createEventStamper, type LoopEvent, type SettlementLoopEvent } from './events.js';
import {
  createAssayNode,
  JobNotChallengeableError,
  JobNotSettleableError,
  ManifestPublishFailedError,
  MissingChallengerAccountError,
  PaymentNotConfirmedError,
  type RegisterProgress,
  ReputationInitFailedError,
  ReputationUpdateFailedError,
  SettlementInProgressError,
  type SettleProgress,
  SlashFailedError,
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

/**
 * Mirrors node.ts's private `hashRequest` exactly, so tests that call
 * `payments.pay()` and `node.serve()` directly (rather than through
 * `payAndCall`, which computes this itself) can hand `confirmPayment` a memo
 * that actually matches the request — otherwise `FakePaymentsPort`'s default
 * memo check (hedera-F1) would reject them for the wrong reason.
 */
function hashRequestForTest(capabilityId: string, request: unknown): string {
  return createHash('sha256').update(JSON.stringify({ capabilityId, request })).digest('hex');
}

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

/** `manifest` minus `bondRef`: what a caller actually hands `register()` (see `RegisterInput`). */
const registerManifestInput: Omit<Manifest, 'bondRef'> = {
  capabilityId: manifest.capabilityId,
  description: manifest.description,
  priceHbar: manifest.priceHbar,
  endpoint: manifest.endpoint,
  verifierHash: manifest.verifierHash,
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
  onLoopEvent?: (event: LoopEvent) => void | Promise<void>,
) {
  const registry = new FakeRegistryPort().seed(PROVIDER_NAME, {
    manifest,
    reputation: { ...seedRecord.reputation, ...reputation },
  });
  const payments = new FakePaymentsPort(paymentsOpts);
  const graph = new FakeGraphPort();
  const capabilities = createCapabilityRegistry();
  capabilities.register(echoCapability);

  const node = createAssayNode({ registry, payments, graph, capabilities, onLoopEvent });
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
    onSettleProgress?: (info: SettleProgress) => void;
    onLoopEvent?: (event: LoopEvent) => void | Promise<void>;
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
    onSettleProgress: opts.onSettleProgress,
    onLoopEvent: opts.onLoopEvent,
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
    // the gate actually consulted the port, it didn't just skip payment (the
    // default fake supports confirmPayment, so that's the branch serve() takes)
    expect(payments.confirmPaymentCalls).toHaveLength(1);
    expect(payments.payCalls).toHaveLength(1);
  });

  it('the payment gate: a failed (never-confirming) payment never produces a served result even called directly through serve()', async () => {
    const { node, payments } = buildNode({ confirmedTxIds: [] });
    const { txId } = await payments.pay(5, hashRequestForTest('echo', 'hello'));

    await expect(
      node.serve({ provider: PROVIDER_NAME, capabilityId: 'echo', request: 'hello', txId }),
    ).rejects.toThrow(PaymentNotConfirmedError);

    expect(node.jobs.list()).toEqual([]);
  });

  it('serves once the payment genuinely confirms, not merely because pay() was called', async () => {
    const { node, payments } = buildNode({ confirmedTxIds: [] });
    const { txId } = await payments.pay(5, hashRequestForTest('echo', 'hello'));

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

  it('the payment gate now also checks amount, recipient binding, and memo, not just SUCCESS (hedera-F1): a confirmed transaction for the wrong amount is refused', async () => {
    const { node, payments } = buildNode();
    const { txId } = await payments.pay(1, hashRequestForTest('echo', 'hello')); // manifest.priceHbar is 5

    await expect(
      node.serve({ provider: PROVIDER_NAME, capabilityId: 'echo', request: 'hello', txId }),
    ).rejects.toThrow(PaymentNotConfirmedError);
    expect(node.jobs.list()).toEqual([]);
  });

  it('the payment gate refuses a confirmed transaction whose memo does not match this capabilityId/request (the requestHash-in-memo binding, made real)', async () => {
    const { node, payments } = buildNode();
    const { txId } = await payments.pay(5, 'memo-for-a-different-request');

    await expect(
      node.serve({ provider: PROVIDER_NAME, capabilityId: 'echo', request: 'hello', txId }),
    ).rejects.toThrow(PaymentNotConfirmedError);
    expect(node.jobs.list()).toEqual([]);
  });

  it('the payment gate refuses replaying an already-consumed txId against a *different* request (memo mismatch catches it)', async () => {
    const { node, payments } = buildNode();

    const { job: firstJob } = await node.payAndCall(PROVIDER_NAME, 'echo', 'hello');
    expect(firstJob.status).toBe('served');

    // Same txId, a different request this payment never actually paid for:
    // the memo bound to the original request does not match this one.
    await expect(
      node.serve({ provider: PROVIDER_NAME, capabilityId: 'echo', request: 'goodbye', txId: firstJob.paymentTx }),
    ).rejects.toThrow(PaymentNotConfirmedError);
    expect(node.jobs.list()).toHaveLength(1);
  });

  it('the job store refuses replaying an already-consumed txId against the *same* request too (the memo would match, so the store itself must dedupe)', async () => {
    const { node } = buildNode();

    const { job: firstJob } = await node.payAndCall(PROVIDER_NAME, 'echo', 'hello');
    expect(firstJob.status).toBe('served');

    // Identical provider/capabilityId/request/txId: confirmPayment's amount
    // and memo checks would both pass again, so it is the job store's own
    // paymentTx dedupe (not the confirmation gate) that must refuse this.
    await expect(
      node.serve({ provider: PROVIDER_NAME, capabilityId: 'echo', request: 'hello', txId: firstJob.paymentTx }),
    ).rejects.toThrow(/already funded job/);
    expect(node.jobs.list()).toHaveLength(1);
  });

  it('a PaymentsPort without confirmPayment (not yet upgraded) still gates on the older, bare confirm() rather than serving unconditionally', async () => {
    const { node, payments } = buildNode({ confirmedTxIds: [], supportConfirmPayment: false });
    const { txId } = await payments.pay(5, 'irrelevant-memo-this-port-cannot-check');

    await expect(
      node.serve({ provider: PROVIDER_NAME, capabilityId: 'echo', request: 'hello', txId }),
    ).rejects.toThrow(PaymentNotConfirmedError);

    payments.setConfirmed(txId);
    const job = await node.serve({ provider: PROVIDER_NAME, capabilityId: 'echo', request: 'hello', txId });
    expect(job.status).toBe('served');
  });

  it('discover surfaces manifest and reputation so a requester can decide whether to pay', async () => {
    const { node } = buildNode();

    const record = await node.discover(PROVIDER_NAME);

    expect(record.manifest).toEqual(manifest);
    expect(record.reputation).toEqual({ score: 80, jobs: 3, slashes: 0, bondHbar: 50 });
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

describe('createAssayNode: settle (#27, concurrency #53)', () => {
  const lieVerdict: Verdict = { valid: false, badClaim: 'echoedLength', reason: 'the length was fabricated' };
  const trueVerdict: Verdict = { valid: true };

  it('an invalid verdict slashes the bond to the challenger and drops the provider\'s ENS reputation concurrently, moving the job to slashed (both legs succeed)', async () => {
    const progress: SettleProgress[] = [];
    const { node, registry, payments, job } = await buildServedNode({
      verify: async () => lieVerdict,
      reputation: { score: 80, jobs: 3, slashes: 0, bondHbar: 50 },
      onSettleProgress: (info) => progress.push(info),
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

    // Proof the two legs actually start together, not one after the other:
    // both `'slashing'` and `'writing-reputation'` are reported before either
    // network call has had a chance to resolve.
    const phases = progress.map((p) => p.phase);
    expect(phases.indexOf('slashing')).toBeLessThan(phases.indexOf('slash-confirmed'));
    expect(phases.indexOf('writing-reputation')).toBeLessThan(phases.indexOf('slash-confirmed'));
    expect(phases).toContain('reputation-confirmed');
    expect(phases[phases.length - 1]).toBe('done');
  });

  it('actually runs the slash and the ENS write concurrently, not sequentially: wall time is close to the slower leg, not their sum', async () => {
    const { node, payments, registry, job } = await buildServedNode({ verify: async () => lieVerdict });
    payments.slashDelayMs = 40;
    registry.updateReputationDelayMs = 120;
    const verdict = await node.challenge(job.jobId, 'echoedLength');

    const start = Date.now();
    await node.settle(job.jobId, verdict);
    const elapsedMs = Date.now() - start;

    // Sequential (the pre-#53 behaviour) would take >= 40 + 120 = 160ms.
    // Concurrent takes ~= max(40, 120) = 120ms. Generous slack for CI jitter,
    // but well under the sequential sum.
    expect(elapsedMs).toBeLessThan(155);
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

  it('two settle() calls racing on the same still-"challenged" job (before either has transitioned it) never both slash: the second is rejected while the first is in flight', async () => {
    const { node, payments, job } = await buildServedNode({ verify: async () => lieVerdict });
    payments.slashDelayMs = 30;
    const verdict = await node.challenge(job.jobId, 'echoedLength');

    const first = node.settle(job.jobId, verdict);
    // Fired while `first` is still in flight (job status still reads
    // "challenged" -- this is exactly the gap `settlingJobIds` exists to
    // close, see node.ts's doc comment on it).
    const second = node.settle(job.jobId, verdict).catch((err) => err);

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe('slashed');
    expect(secondResult).toBeInstanceOf(SettlementInProgressError);
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

  it('when the slash transaction itself fails and the concurrent ENS write also fails, nothing changed anywhere and the job stays challenged, safe to retry', async () => {
    const { node, registry, payments, job } = await buildServedNode({ verify: async () => lieVerdict });
    const verdict = await node.challenge(job.jobId, 'echoedLength');
    const reputationBefore = (await registry.resolveProvider(PROVIDER_NAME)).reputation;
    payments.slashError = new Error('Hedera testnet is congested');
    registry.updateReputationError = new Error('Sepolia RPC timed out');

    let err!: SlashFailedError;
    try {
      await node.settle(job.jobId, verdict);
      throw new Error('should have thrown');
    } catch (caught) {
      expect(caught).toBeInstanceOf(SlashFailedError);
      err = caught as SlashFailedError;
    }
    expect(err.message).toMatch(/congested/);
    expect(err.reputationWrite).toEqual({ outcome: 'failed', cause: expect.any(Error) });

    expect(node.jobs.get(job.jobId).status).toBe('challenged');
    // ENS genuinely untouched: both legs failed, so nothing to reconcile.
    expect((await registry.resolveProvider(PROVIDER_NAME)).reputation).toEqual(reputationBefore);

    // the retry (both one-shot errors cleared themselves after firing once) succeeds cleanly
    const settled = await node.settle(job.jobId, verdict);
    expect(settled.status).toBe('slashed');
    expect(payments.slashCalls).toHaveLength(2);
  });

  it('when the slash transaction fails but the concurrent ENS write still succeeds, the job stays honestly "challenged" (no slash happened) even though ENS now shows one', async () => {
    const { node, registry, payments, job } = await buildServedNode({
      verify: async () => lieVerdict,
      reputation: { score: 80, jobs: 3, slashes: 0, bondHbar: 50 },
    });
    const verdict = await node.challenge(job.jobId, 'echoedLength');
    payments.slashError = new Error('Hedera testnet is congested');

    let err!: SlashFailedError;
    try {
      await node.settle(job.jobId, verdict);
      throw new Error('should have thrown');
    } catch (caught) {
      expect(caught).toBeInstanceOf(SlashFailedError);
      err = caught as SlashFailedError;
    }
    expect(err.reputationWrite.outcome).toBe('succeeded');

    // The job never claims a slash that did not happen.
    expect(node.jobs.get(job.jobId).status).toBe('challenged');

    // But ENS was never gated on the slash succeeding, so it already moved --
    // the exact inconsistency `SlashFailedError` exists to name rather than hide.
    const expectedDelta = computeSlashReputationDelta({ score: 80, jobs: 3, slashes: 0, bondHbar: 50 });
    const afterFirstAttempt = await registry.resolveProvider(PROVIDER_NAME);
    expect(afterFirstAttempt.reputation).toEqual({ ...expectedDelta, bondHbar: 50 });
    if (err.reputationWrite.outcome === 'succeeded') {
      expect(err.reputationWrite.reputation).toEqual(afterFirstAttempt.reputation);
    }

    // Retrying (slashError cleared itself after firing once) now lets the
    // slash land for real, and the job correctly becomes "slashed" -- but
    // the disclosed trade-off from running the two legs concurrently shows
    // up here: the retry's reputation delta is computed off the *already
    // written* (already-slashed-looking) ENS value, not the original 80, so
    // the score ends up penalized twice for one real slash. This is the
    // known, documented cost of #53's concurrency (see `SlashFailedError`'s
    // doc comment), not a bug this test is hiding.
    const settled = await node.settle(job.jobId, verdict);
    expect(settled.status).toBe('slashed');
    expect(payments.slashCalls).toHaveLength(2);
    const afterRetry = await registry.resolveProvider(PROVIDER_NAME);
    expect(afterRetry.reputation.slashes).toBe(2);
    expect(afterRetry.reputation.score).toBeLessThan(afterFirstAttempt.reputation.score);
  });

  it('rejects an unknown job id', async () => {
    const { node } = buildNode();
    await expect(node.settle('no-such-job', trueVerdict)).rejects.toThrow(/Unknown job/);
  });
});

describe('createAssayNode: register (#17)', () => {
  const FRESH_PROVIDER_NAME = 'fresh.assay.eth';

  function buildFreshNode(onRegisterProgress?: (info: RegisterProgress) => void) {
    const registry = new FakeRegistryPort();
    const payments = new FakePaymentsPort();
    const graph = new FakeGraphPort();
    const capabilities = createCapabilityRegistry();
    capabilities.register(echoCapability);

    const node = createAssayNode({ registry, payments, graph, capabilities, onRegisterProgress });
    return { node, registry, payments, graph };
  }

  it('happy path: bonds first, publishes the manifest carrying the real bondRef, then initializes reputation from zero, in that order', async () => {
    const progress: RegisterProgress[] = [];
    const { node, registry, payments } = buildFreshNode((info) => progress.push(info));

    const result = await node.register({
      name: FRESH_PROVIDER_NAME,
      manifest: registerManifestInput,
      bondHbar: 50,
    });

    // the bond really happened, and produced the bondRef/bondTxId
    expect(payments.postBondCalls).toEqual([50]);
    expect(result.bondRef).toMatch(/^fake-bond-/);
    expect(result.bondTxId).toMatch(/^0xfake-bond-/);

    // the published manifest carries that *real* bondRef, not a placeholder
    expect(registry.publishedManifests).toEqual([
      { name: FRESH_PROVIDER_NAME, manifest: { ...registerManifestInput, bondRef: result.bondRef } },
    ]);
    expect(result.manifestTxHash).toMatch(/^0xfake-manifest-/);

    // reputation was initialized from zero (a name registered for the first
    // time), with bondHbar reflecting the real bond just posted
    expect(result.reputation).toEqual({ score: 0, jobs: 0, slashes: 0, bondHbar: 50 });
    expect(result.reputationTxHash).toMatch(/^0xfake-rep-/);

    // and the provider is now genuinely discoverable end to end
    const discovered = await node.discover(FRESH_PROVIDER_NAME);
    expect(discovered.manifest.bondRef).toBe(result.bondRef);
    expect(discovered.reputation).toEqual(result.reputation);

    // progress was reported in order, one tick per phase boundary
    expect(progress.map((p) => p.phase)).toEqual([
      'posting-bond',
      'publishing-manifest',
      'initializing-reputation',
      'done',
    ]);
    expect(progress[1]).toMatchObject({ bondRef: result.bondRef, bondTxId: result.bondTxId });
    expect(progress[2]).toMatchObject({ bondRef: result.bondRef, manifestTxHash: result.manifestTxHash });
    expect(progress[3]).toMatchObject({ result });
  });

  it('bond-succeeds-then-ENS-fails: the manifest publish failing leaves the provider bonded but unlisted, and the error carries the real bondRef/bondTxId/manifest so the caller can retry the manifest publish directly, without posting a second bond', async () => {
    const { node, registry, payments } = buildFreshNode();
    registry.publishManifestError = new Error('Sepolia RPC timed out');

    let caught: ManifestPublishFailedError | undefined;
    try {
      await node.register({ name: FRESH_PROVIDER_NAME, manifest: registerManifestInput, bondHbar: 50 });
      throw new Error('should have thrown');
    } catch (err) {
      caught = err as ManifestPublishFailedError;
    }

    expect(caught).toBeInstanceOf(ManifestPublishFailedError);
    expect(caught!.providerName).toBe(FRESH_PROVIDER_NAME);
    expect(caught!.bondRef).toMatch(/^fake-bond-/);
    expect(caught!.manifest).toEqual({ ...registerManifestInput, bondRef: caught!.bondRef });

    // the money already moved: one real bond was posted
    expect(payments.postBondCalls).toEqual([50]);
    // but nothing on ENS reflects it yet
    expect(registry.publishedManifests).toEqual([]);

    // recovery: retry the manifest publish directly (not register() again),
    // using the bondRef the failed attempt's bond already produced
    const { txHash } = await registry.publishManifest(FRESH_PROVIDER_NAME, caught!.manifest);
    expect(txHash).toMatch(/^0xfake-manifest-/);
    // still only the one bond from the failed register() call -- the retry
    // never posted a second one
    expect(payments.postBondCalls).toEqual([50]);
  });

  it('bond and manifest succeed but the reputation-init write fails: the provider is listed but not yet discoverable, and the error names it', async () => {
    const { node, registry, payments } = buildFreshNode();
    registry.updateReputationError = new Error('Sepolia RPC timed out');

    let caught: ReputationInitFailedError | undefined;
    try {
      await node.register({ name: FRESH_PROVIDER_NAME, manifest: registerManifestInput, bondHbar: 50 });
      throw new Error('should have thrown');
    } catch (err) {
      caught = err as ReputationInitFailedError;
    }

    expect(caught).toBeInstanceOf(ReputationInitFailedError);
    expect(caught!.providerName).toBe(FRESH_PROVIDER_NAME);
    expect(caught!.bondRef).toMatch(/^fake-bond-/);
    expect(caught!.manifestTxHash).toMatch(/^0xfake-manifest-/);

    // the bond and the manifest are both real and durable
    expect(payments.postBondCalls).toEqual([50]);
    expect(registry.publishedManifests).toHaveLength(1);

    // (the real `@assay/registry` adapter's `resolveProvider` throws
    // `MissingRecordError` here until `assay:rep` actually exists --
    // `FakeRegistryPort.publishManifest` gives every published name a zero
    // reputation up front as a simplification other tests already rely on,
    // so this fake alone can't exercise that "listed but not discoverable"
    // gap; the error type/message above is what documents it.)

    // recovery: retry just the reputation write directly
    const { reputation } = await registry.updateReputation(FRESH_PROVIDER_NAME, { bondHbar: 50 });
    expect(reputation).toEqual({ score: 0, jobs: 0, slashes: 0, bondHbar: 50 });
  });

  it('re-registration: posts a fresh bond and republishes the manifest, but the reputation write merges onto history rather than resetting it', async () => {
    const { node, registry, payments } = buildNode(); // PROVIDER_NAME already seeded: score 80, jobs 3, slashes 0, bondHbar 50

    const result = await node.register({
      name: PROVIDER_NAME,
      manifest: registerManifestInput,
      bondHbar: 5,
    });

    // a real, fresh bond was posted -- re-registration does not reuse the old one
    expect(payments.postBondCalls).toEqual([5]);
    expect(result.bondRef).toMatch(/^fake-bond-/);

    // the manifest was overwritten with the new bondRef
    expect(registry.publishedManifests).toEqual([
      { name: PROVIDER_NAME, manifest: { ...registerManifestInput, bondRef: result.bondRef } },
    ]);

    // reputation's score/jobs/slashes survive the re-registration (history is
    // not erased); only bondHbar changes, to reflect the bond just posted
    expect(result.reputation).toEqual({ score: 80, jobs: 3, slashes: 0, bondHbar: 5 });

    const discovered = await node.discover(PROVIDER_NAME);
    expect(discovered.reputation).toEqual(result.reputation);
    expect(discovered.manifest.bondRef).toBe(result.bondRef);
  });
});

describe('createAssayNode: verifyClaim (#83)', () => {
  it("routes to capability.verify() with the full claim set at each claim's own atBlock, without transitioning the job or recording a verdict", async () => {
    let calledWith: unknown;
    const verdict: Verdict = { valid: true };
    const { node, job, graph } = await buildServedNode({
      verify: async (req, result, claims) => {
        calledWith = { req, result, claims };
        return verdict;
      },
    });

    // Prove this doesn't fall back to "verify against the chain head": the
    // fake graph's head is nowhere near the claim's own stamped atBlock, so
    // if verify() ever got handed the head instead of atBlock this would be
    // the wrong number.
    expect(await graph.getLatestBlock()).not.toBe(job.claims[0]?.atBlock);
    expect(job.claims.every((claim) => claim.atBlock === 12345)).toBe(true);

    const returned = await node.verifyClaim(job.jobId, 'echoedLength');

    expect(returned).toEqual(verdict);
    expect(calledWith).toEqual({ req: 'hello', result: { echoed: 'hello' }, claims: job.claims });

    // job state is completely untouched: still served, no verdict recorded
    const unchanged = node.jobs.get(job.jobId);
    expect(unchanged.status).toBe('served');
    expect(unchanged.verdict).toBeUndefined();
  });

  it('does not mutate job state even on a false verdict, and repeated calls stay side-effect free', async () => {
    const { node, job } = await buildServedNode({
      verify: async () => ({ valid: false, badClaim: 'echoedLength', reason: 'lied' }),
    });

    await node.verifyClaim(job.jobId, 'echoedLength');
    await node.verifyClaim(job.jobId, 'echoedLength');

    const unchanged = node.jobs.get(job.jobId);
    expect(unchanged.status).toBe('served');
    expect(unchanged.verdict).toBeUndefined();
  });

  it('never calls settle(): an invalid verdict from verifyClaim never slashes anything', async () => {
    const { node, payments, job } = await buildServedNode({
      verify: async () => ({ valid: false, badClaim: 'echoedLength' }),
    });

    await node.verifyClaim(job.jobId, 'echoedLength');

    expect(payments.slashCalls).toEqual([]);
    expect(node.jobs.get(job.jobId).status).toBe('served');
  });

  it('unlike challenge(), can re-verify a job that already moved past served (challenged/slashed)', async () => {
    const { node, job } = await buildServedNode({
      verify: async () => ({ valid: false, badClaim: 'echoedLength' }),
      reputation: { score: 80, jobs: 3, slashes: 0, bondHbar: 50 },
    });
    const verdict = await node.challenge(job.jobId, 'echoedLength');
    const settled = await node.settle(job.jobId, verdict);
    expect(settled.status).toBe('slashed');

    // verifyClaim still works on an already-slashed job -- no status gate at all
    const recheck = await node.verifyClaim(job.jobId, 'echoedLength');
    expect(recheck).toEqual({ valid: false, badClaim: 'echoedLength' });

    // and settle()'s own recorded status/verdict are untouched by the recheck
    const stillSlashed = node.jobs.get(job.jobId);
    expect(stillSlashed.status).toBe('slashed');
    expect(stillSlashed.verdict).toEqual(verdict);
  });

  it('rejects an unknown claim key without ever calling verify()', async () => {
    let verifyCalls = 0;
    const { node, job } = await buildServedNode({
      verify: async () => {
        verifyCalls += 1;
        return { valid: true };
      },
    });

    await expect(node.verifyClaim(job.jobId, 'noSuchClaim')).rejects.toThrow(UnknownClaimError);
    expect(verifyCalls).toBe(0);
    expect(node.jobs.get(job.jobId).status).toBe('served');
  });

  it('rejects an unknown job id', async () => {
    const { node } = buildNode();
    await expect(node.verifyClaim('no-such-job', 'echoedLength')).rejects.toThrow(/Unknown job/);
  });

  it("propagates the capability's own verify() failure and leaves the job untouched at served, so it stays retryable", async () => {
    const { node, job } = await buildServedNode({
      verify: async () => {
        throw new Error('The Graph is unreachable at this block');
      },
    });

    await expect(node.verifyClaim(job.jobId, 'echoedLength')).rejects.toThrow(/unreachable/);
    expect(node.jobs.get(job.jobId).status).toBe('served');
  });

  it('emits a VerifyLoopEvent with committed:false, and never emits a ChallengeLoopEvent', async () => {
    const events: LoopEvent[] = [];
    const registry = new FakeRegistryPort().seed(PROVIDER_NAME, seedRecord);
    const payments = new FakePaymentsPort();
    const graph = new FakeGraphPort();
    const capabilities = createCapabilityRegistry();
    const verdict: Verdict = { valid: true };
    capabilities.register(makeEchoCapability(async () => verdict));
    const node = createAssayNode({
      registry,
      payments,
      graph,
      capabilities,
      onLoopEvent: (event) => { events.push(event); },
    });

    const { job } = await node.payAndCall(PROVIDER_NAME, 'echo', 'hello');
    events.length = 0; // discard the register/pay/serve/accept noise from payAndCall

    const returned = await node.verifyClaim(job.jobId, 'echoedLength');

    expect(returned).toEqual(verdict);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      step: 'verify',
      jobId: job.jobId,
      claimKey: 'echoedLength',
      verdict,
      committed: false,
    });
    expect(events.some((event) => event.step === 'challenge')).toBe(false);
  });
});

describe('createAssayNode: loop events (#83)', () => {
  it('emits a complete, artifact-bearing event stream across discover, the pay decision, pay, confirm, serve, accept, challenge, and the verdict', async () => {
    const events: LoopEvent[] = [];
    const lieVerdict: Verdict = { valid: false, badClaim: 'echoedLength', reason: 'the length was fabricated' };
    const { node, job } = await buildServedNode({
      verify: async () => lieVerdict,
      reputation: { score: 80, jobs: 3, slashes: 0, bondHbar: 50 },
      onLoopEvent: (event) => { events.push(event); },
    });

    // discover(): fired separately below, buildServedNode's own payAndCall doesn't call it
    const discovered = await node.discover(PROVIDER_NAME);
    expect(events).toContainEqual(
      expect.objectContaining({ step: 'discover', outcome: 'ok', name: PROVIDER_NAME, provider: discovered }),
    );

    const verdict = await node.challenge(job.jobId, 'echoedLength');
    await node.settle(job.jobId, verdict);

    // pay: assessed -> paid -> confirming -> confirmed, in order, real artifacts attached
    const payEvents = events.filter((event): event is Extract<LoopEvent, { step: 'pay' }> => event.step === 'pay');
    expect(payEvents.map((event) => event.phase)).toEqual(['assessed', 'paid', 'confirming', 'confirmed']);
    const paidEvent = payEvents.find((event) => event.phase === 'paid');
    expect(paidEvent).toMatchObject({ txId: job.paymentTx, amountHbar: manifest.priceHbar });
    const assessedEvent = payEvents.find((event) => event.phase === 'assessed');
    expect(assessedEvent).toMatchObject({ name: PROVIDER_NAME, decision: { pay: true } });
    if (assessedEvent?.phase === 'assessed') {
      expect(assessedEvent.assessment.providerName).toBe(PROVIDER_NAME);
    }

    // serve + accept: the real, block-stamped job
    expect(events).toContainEqual(expect.objectContaining({ step: 'serve', outcome: 'ok', job }));
    expect(events).toContainEqual(expect.objectContaining({ step: 'accept', job }));

    // challenge: started, then the verdict as a committed VerifyLoopEvent
    expect(events).toContainEqual(
      expect.objectContaining({ step: 'challenge', phase: 'started', jobId: job.jobId, claimKey: 'echoedLength' }),
    );
    const verifyEvents = events.filter((event) => event.step === 'verify');
    expect(verifyEvents).toHaveLength(1);
    expect(verifyEvents[0]).toMatchObject({
      jobId: job.jobId,
      claimKey: 'echoedLength',
      verdict: lieVerdict,
      committed: true,
    });
    expect(verifyEvents[0]).toMatchObject({ claims: job.claims });

    // slash + reputation: the real before/after reputation and a real txId
    const slashEvents = events.filter((event) => event.step === 'slash');
    expect(slashEvents.length).toBeGreaterThan(0);
    const reputationEvents = events.filter(
      (event): event is LoopEvent & SettlementLoopEvent => event.step === 'reputation',
    );
    const confirmedReputation = reputationEvents.find(
      (event) => event.progress.phase === 'reputation-confirmed',
    );
    expect(confirmedReputation).toBeDefined();
    expect(confirmedReputation?.before).toEqual({ score: 80, jobs: 3, slashes: 0, bondHbar: 50 });
    if (confirmedReputation?.progress.phase === 'reputation-confirmed') {
      expect(confirmedReputation.progress.reputation.score).toBeLessThan(80);
      expect(confirmedReputation.progress.reputation.slashes).toBe(1);
    }
  });

  it("register()'s progress reports one RegisterLoopEvent per phase, matching onRegisterProgress's own ticks exactly (built once, forwarded to both, not twice)", async () => {
    const events: LoopEvent[] = [];
    const registerTicks: RegisterProgress[] = [];
    const registry = new FakeRegistryPort();
    const payments = new FakePaymentsPort();
    const graph = new FakeGraphPort();
    const capabilities = createCapabilityRegistry();
    capabilities.register(echoCapability);
    const node = createAssayNode({
      registry,
      payments,
      graph,
      capabilities,
      onRegisterProgress: (progress) => registerTicks.push(progress),
      onLoopEvent: (event) => { events.push(event); },
    });

    const result = await node.register({ name: 'events-register.assay.eth', manifest: registerManifestInput, bondHbar: 50 });

    const registerEvents = events.filter((event): event is Extract<LoopEvent, { step: 'register' }> => event.step === 'register');
    expect(registerEvents.map((event) => event.progress)).toEqual(registerTicks);
    expect(registerTicks.map((tick) => tick.phase)).toEqual([
      'posting-bond',
      'publishing-manifest',
      'initializing-reputation',
      'done',
    ]);
    expect(registerEvents.at(-1)?.progress).toMatchObject({ phase: 'done', result });
  });

  it("payAndCall declining still emits the 'assessed' phase naming the decision, and never reaches 'paid'", async () => {
    const events: LoopEvent[] = [];
    const { node } = buildNode(undefined, { jobs: 4, slashes: 2, bondHbar: 50 }, (event) => { events.push(event); });

    await expect(node.payAndCall(PROVIDER_NAME, 'echo', 'hello')).rejects.toThrow(PayDeclinedError);

    const payEvents = events.filter((event) => event.step === 'pay');
    expect(payEvents).toHaveLength(1);
    expect(payEvents[0]).toMatchObject({ phase: 'assessed', decision: { pay: false } });
  });

  it("serve() emits a 'failed' ServeLoopEvent when the job store rejects a re-served payment, while pay itself still reports 'confirmed'", async () => {
    const events: LoopEvent[] = [];
    const { node } = buildNode(undefined, {}, (event) => { events.push(event); });

    const { job: firstJob } = await node.payAndCall(PROVIDER_NAME, 'echo', 'hello');
    events.length = 0;

    await expect(
      node.serve({ provider: PROVIDER_NAME, capabilityId: 'echo', request: 'hello', txId: firstJob.paymentTx }),
    ).rejects.toThrow(/already funded job/);

    expect(events).toContainEqual(expect.objectContaining({ step: 'pay', phase: 'confirmed', txId: firstJob.paymentTx }));
    const failedServe = events.find((event) => event.step === 'serve');
    expect(failedServe).toMatchObject({
      step: 'serve',
      outcome: 'failed',
      provider: PROVIDER_NAME,
      capabilityId: 'echo',
      txId: firstJob.paymentTx,
    });
    expect(events.some((event) => event.step === 'accept')).toBe(false);
  });

  it("serve() emits 'not-confirmed' when the payment never confirms, and never reaches serve/accept", async () => {
    const events: LoopEvent[] = [];
    const { node, payments } = buildNode({ confirmedTxIds: [] }, {}, (event) => { events.push(event); });
    const { txId } = await payments.pay(5, hashRequestForTest('echo', 'hello'));
    events.length = 0;

    await expect(
      node.serve({ provider: PROVIDER_NAME, capabilityId: 'echo', request: 'hello', txId }),
    ).rejects.toThrow(PaymentNotConfirmedError);

    expect(events.map((event) => (event.step === 'pay' ? event.phase : event.step))).toEqual([
      'confirming',
      'not-confirmed',
    ]);
    expect(events.some((event) => event.step === 'serve' || event.step === 'accept')).toBe(false);
  });

  it("discover() emits a 'failed' DiscoverLoopEvent, carrying the real error, for an unresolvable provider name", async () => {
    const events: LoopEvent[] = [];
    const { node } = buildNode(undefined, {}, (event) => { events.push(event); });

    await expect(node.discover('no-such-provider.assay.eth')).rejects.toThrow();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ step: 'discover', outcome: 'failed', name: 'no-such-provider.assay.eth' });
    if (events[0].step === 'discover' && events[0].outcome === 'failed') {
      expect(events[0].error).toBeInstanceOf(Error);
    }
  });

  it('a synchronously throwing onLoopEvent never breaks a full happy-path run: register, payAndCall, challenge, and settle all complete normally', async () => {
    const registry = new FakeRegistryPort();
    const payments = new FakePaymentsPort();
    const graph = new FakeGraphPort();
    const capabilities = createCapabilityRegistry();
    capabilities.register(makeEchoCapability(async () => ({ valid: true })));

    let eventCount = 0;
    const node = createAssayNode({
      registry,
      payments,
      graph,
      capabilities,
      challengerAccountId: CHALLENGER_ACCOUNT_ID,
      onLoopEvent: () => {
        eventCount += 1;
        throw new Error('narration is broken, on purpose, on every single event');
      },
    });

    const registerResult = await node.register({
      name: 'throwing-emitter.assay.eth',
      manifest: registerManifestInput,
      bondHbar: 50,
    });
    expect(registerResult.reputation).toEqual({ score: 0, jobs: 0, slashes: 0, bondHbar: 50 });

    const { job } = await node.payAndCall('throwing-emitter.assay.eth', 'echo', 'hello');
    expect(job.status).toBe('served');

    const verdict = await node.challenge(job.jobId, 'echoedLength');
    const settled = await node.settle(job.jobId, verdict);
    expect(settled.status).toBe('settled');

    // proof the throwing hook was actually invoked throughout, not skipped
    expect(eventCount).toBeGreaterThan(5);
  });

  it('an onLoopEvent that returns a rejecting promise on every event never breaks a full happy-path run (and never surfaces as an unhandled rejection)', async () => {
    const registry = new FakeRegistryPort().seed(PROVIDER_NAME, seedRecord);
    const payments = new FakePaymentsPort();
    const graph = new FakeGraphPort();
    const capabilities = createCapabilityRegistry();
    capabilities.register(makeEchoCapability(async () => ({ valid: true })));

    let eventCount = 0;
    const node = createAssayNode({
      registry,
      payments,
      graph,
      capabilities,
      onLoopEvent: async () => {
        eventCount += 1;
        throw new Error('async narration is broken, on purpose, on every single event');
      },
    });

    const { job } = await node.payAndCall(PROVIDER_NAME, 'echo', 'hello');
    expect(job.status).toBe('served');

    const verdict = await node.challenge(job.jobId, 'echoedLength');
    expect(verdict).toEqual({ valid: true });

    expect(eventCount).toBeGreaterThan(3);
  });

  it('createEventStamper: a shared stamper gives two independent LoopEvent sources one strictly increasing seq, not two separately-numbered ones', async () => {
    const stamp = createEventStamper();
    const events: LoopEvent[] = [];

    const registry = new FakeRegistryPort().seed(PROVIDER_NAME, seedRecord);
    const payments = new FakePaymentsPort();
    const graph = new FakeGraphPort();
    const capabilities = createCapabilityRegistry();
    capabilities.register(echoCapability);
    const node = createAssayNode({
      registry,
      payments,
      graph,
      capabilities,
      eventStamper: stamp,
      onLoopEvent: (event) => { events.push(event); },
    });

    await node.payAndCall(PROVIDER_NAME, 'echo', 'hello');

    // A composition root synthesizing its own event (e.g. apps/mcp's rate(),
    // which lives entirely outside AssayNode) stamps with the very same
    // function, sharing the one counter rather than starting a fresh one.
    const synthetic = stamp({ step: 'discover', outcome: 'ok', name: PROVIDER_NAME, provider: await node.discover(PROVIDER_NAME) });
    events.push(synthetic);

    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    // the synthetic event's seq continues the same counter, not a fresh one
    expect(synthetic.seq).toBe(Math.max(...seqs.slice(0, -1)) + 1);
  });

  it('seq is monotonically increasing and at is a real timestamp by default, with no eventStamper configured', async () => {
    const events: LoopEvent[] = [];
    const { node } = buildNode(undefined, {}, (event) => { events.push(event); });

    await node.payAndCall(PROVIDER_NAME, 'echo', 'hello');

    expect(events.length).toBeGreaterThan(1);
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i].seq).toBe(events[i - 1].seq + 1);
      expect(events[i].at).toBeGreaterThanOrEqual(events[i - 1].at);
    }
  });
});

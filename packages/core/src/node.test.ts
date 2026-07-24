import { describe, expect, it } from 'vitest';
import { createAssayNode, PaymentNotConfirmedError } from './node.js';
import { PayDeclinedError } from './pay-policy.js';
import { createCapabilityRegistry } from './runtime.js';
import {
  FakeGraphPort,
  FakePaymentsPort,
  FakeRegistryPort,
  type FakePaymentsPortOptions,
} from './test-support/fakes.js';
import type { Capability, Manifest, ProviderRecord, Reputation } from './types.js';

const PROVIDER_NAME = 'rugscore.assay.eth';

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

/**
 * A trivial capability whose result carries one block-stamped claim, so the
 * loop test can assert claims survive intact into the job. Not rug-score:
 * core must not know that capability exists.
 */
const echoCapability: Capability<string, { echoed: string }> = {
  id: 'echo',
  async run(req) {
    return {
      result: { echoed: req },
      claims: [{ k: 'echoedLength', v: req.length, atBlock: 12345 }],
    };
  },
  async verify() {
    return { valid: true };
  },
};

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

  it('leaves challenge/settle as explicit extension points for #26/#27, not half-implementations', async () => {
    const { node } = buildNode();
    const { job } = await node.payAndCall(PROVIDER_NAME, 'echo', 'hello');

    await expect(node.challenge(job.jobId, 'echoedLength')).rejects.toThrow(/#26/);
    await expect(node.settle(job.jobId, { valid: false })).rejects.toThrow(/#27/);

    // neither extension point silently mutated the job
    expect(node.jobs.get(job.jobId).status).toBe('served');
  });
});

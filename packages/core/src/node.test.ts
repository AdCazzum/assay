import { describe, expect, it } from 'vitest';
import { createAssayNode, PaymentNotConfirmedError } from './node.js';
import { createCapabilityRegistry } from './runtime.js';
import {
  FakeGraphPort,
  FakePaymentsPort,
  FakeRegistryPort,
  type FakePaymentsPortOptions,
} from './test-support/fakes.js';
import type { Capability, Manifest, ProviderRecord } from './types.js';

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

function buildNode(paymentsOpts?: FakePaymentsPortOptions) {
  const registry = new FakeRegistryPort().seed(PROVIDER_NAME, seedRecord);
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

  it('leaves challenge/settle as explicit extension points for #26/#27, not half-implementations', async () => {
    const { node } = buildNode();
    const { job } = await node.payAndCall(PROVIDER_NAME, 'echo', 'hello');

    await expect(node.challenge(job.jobId, 'echoedLength')).rejects.toThrow(/#26/);
    await expect(node.settle(job.jobId, { valid: false })).rejects.toThrow(/#27/);

    // neither extension point silently mutated the job
    expect(node.jobs.get(job.jobId).status).toBe('served');
  });
});

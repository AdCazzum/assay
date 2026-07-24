import { describe, expect, it } from 'vitest';
import { createCapabilityRegistry, createJobStore, PayDeclinedError } from '@assay/core';
import type { Capability, Manifest, ProviderRecord } from '@assay/core';
import { createLiveAssayNode, RateNotApplicableError } from './live-node.js';
import {
  FakeGraphPort,
  FakePaymentsPort,
  FakeRegistryPort,
  Issue16StubRegistryPort,
  type FakePaymentsPortOptions,
} from './test-support/live-ports.js';

const PROVIDER_NAME = 'rugscore.assay.eth';

const manifest: Manifest = {
  capabilityId: 'echo',
  description: 'echoes a request back with its length as a fabricated claim, orchestration tests only',
  priceHbar: 5,
  endpoint: 'https://example.invalid/echo',
  bondRef: 'bond-seed',
  verifierHash: '0xseed',
};

/** Trivial capability so these tests never depend on `@assay/cap-rugscore`, which is being reshaped in a sibling issue. */
const echoCapability: Capability<string, { echoed: string }> = {
  id: 'echo',
  async run(req) {
    return { result: { echoed: req }, claims: [{ k: 'echoedLength', v: req.length, atBlock: 1 }] };
  },
  async verify() {
    return { valid: true };
  },
};

function buildLiveNode(opts?: {
  reputation?: Partial<ProviderRecord['reputation']>;
  paymentsOpts?: FakePaymentsPortOptions;
}) {
  const registry = new FakeRegistryPort().seed(PROVIDER_NAME, {
    manifest,
    reputation: { score: 80, jobs: 20, slashes: 0, bondHbar: 50, ...opts?.reputation },
  });
  const payments = new FakePaymentsPort(opts?.paymentsOpts);
  const graph = new FakeGraphPort();
  const capabilities = createCapabilityRegistry();
  capabilities.register(echoCapability);
  const jobs = createJobStore();

  const node = createLiveAssayNode({ registry, payments, graph, capabilities, jobs });
  return { node, registry, payments, graph, jobs };
}

describe('createLiveAssayNode', () => {
  describe('discover', () => {
    it('resolves the provider over the real registry port and returns it alongside the real assessProvider read', async () => {
      const { node } = buildLiveNode();

      const { provider, assessment } = await node.discover(PROVIDER_NAME);

      expect(provider.manifest).toEqual(manifest);
      expect(provider.reputation.jobs).toBe(20);
      // this is the actual assessProvider output, not a hand-rolled summary
      expect(assessment.providerName).toBe(PROVIDER_NAME);
      expect(assessment.unproven).toBe(false);
      expect(assessment.signals.length).toBeGreaterThan(0);
    });
  });

  describe('payAndCall', () => {
    it('pays and serves for real when the policy passes (default force: false)', async () => {
      const { node, payments } = buildLiveNode();

      const job = await node.payAndCall(PROVIDER_NAME, 'hello');

      expect(job.status).toBe('served');
      expect(job.provider).toBe(PROVIDER_NAME);
      expect(job.result).toEqual({ echoed: 'hello' });
      expect(payments.payCalls).toHaveLength(1);
    });

    it('declines without paying when the policy floor is violated, surfacing PayDeclinedError', async () => {
      const { node, payments } = buildLiveNode({ reputation: { jobs: 4, slashes: 2 } });

      await expect(node.payAndCall(PROVIDER_NAME, 'hello')).rejects.toThrow(PayDeclinedError);
      expect(payments.payCalls).toHaveLength(0);
    });

    it('force: true bypasses the policy floor and still pays and serves for real', async () => {
      const { node, payments } = buildLiveNode({ reputation: { jobs: 4, slashes: 2 } });

      const job = await node.payAndCall(PROVIDER_NAME, 'hello', true);

      expect(job.status).toBe('served');
      expect(payments.payCalls).toHaveLength(1);
    });

    it('resolves the capability registry id off the manifest rather than assuming it equals the ENS name', async () => {
      const { node } = buildLiveNode();

      // PROVIDER_NAME ("rugscore.assay.eth") != manifest.capabilityId ("echo"):
      // this only works if payAndCall reads capabilityId off the resolved
      // manifest instead of reusing the ENS name as the capability id.
      const job = await node.payAndCall(PROVIDER_NAME, 'hi');
      expect(job.result).toEqual({ echoed: 'hi' });
    });
  });

  describe('challenge', () => {
    it('still fails with a clear, named message until #26 lands', async () => {
      const { node } = buildLiveNode();
      const job = await node.payAndCall(PROVIDER_NAME, 'hello');

      await expect(node.challenge(job.jobId, 'echoedLength')).rejects.toThrow(/#26/);
    });
  });

  describe('rate', () => {
    it('rejects an unknown job id (no core change needed: JobStore.get already throws UnknownJobError)', async () => {
      const { node } = buildLiveNode();
      await expect(node.rate('no-such-job', true)).rejects.toThrow(/Unknown job/);
    });

    it('refuses to rate a job that is not "served" (e.g. already moved past served)', async () => {
      const { node, jobs } = buildLiveNode();
      const job = await node.payAndCall(PROVIDER_NAME, 'hello');
      // Core has no real path from `served` to `challenged` today outside
      // `challenge()` itself (which always throws, #26); driving the store
      // directly here only simulates the state rate() must refuse, it is
      // not claiming challenge() works.
      jobs.transition(job.jobId, 'challenged');

      await expect(node.rate(job.jobId, true)).rejects.toThrow(RateNotApplicableError);
    });

    it('bumps jobs and score by resolving the current reputation and writing the new totals', async () => {
      const { node, registry } = buildLiveNode({ reputation: { jobs: 20, score: 80 } });
      const job = await node.payAndCall(PROVIDER_NAME, 'hello');

      await node.rate(job.jobId, true);

      const updated = await registry.resolveProvider(PROVIDER_NAME);
      expect(updated.reputation.jobs).toBe(21);
      expect(updated.reputation.score).toBe(81);
    });

    it('bumps jobs but not score when unsatisfied', async () => {
      const { node, registry } = buildLiveNode({ reputation: { jobs: 20, score: 80 } });
      const job = await node.payAndCall(PROVIDER_NAME, 'hello');

      await node.rate(job.jobId, false);

      const updated = await registry.resolveProvider(PROVIDER_NAME);
      expect(updated.reputation.jobs).toBe(21);
      expect(updated.reputation.score).toBe(80);
    });

    it('surfaces the real registry adapter\'s #16 stub as a clear, named error rather than a fake success', async () => {
      const registry = new Issue16StubRegistryPort({
        name: PROVIDER_NAME,
        manifest,
        reputation: { score: 80, jobs: 20, slashes: 0, bondHbar: 50 },
      });
      const payments = new FakePaymentsPort();
      const graph = new FakeGraphPort();
      const capabilities = createCapabilityRegistry();
      capabilities.register(echoCapability);
      const jobs = createJobStore();
      const node = createLiveAssayNode({ registry, payments, graph, capabilities, jobs });

      const job = await node.payAndCall(PROVIDER_NAME, 'hello');

      await expect(node.rate(job.jobId, true)).rejects.toThrow(/#16/);
    });
  });
});

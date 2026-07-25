import { describe, expect, it } from 'vitest';
import {
  createCapabilityRegistry,
  createJobStore,
  PayDeclinedError,
  ReputationUpdateFailedError,
  type LoopEvent,
} from '@assay/core';
import type { Capability, Manifest, ProviderRecord } from '@assay/core';
import {
  createLiveAssayNode,
  InvalidProviderLabelError,
  MissingEnsParentNameError,
  RateNotApplicableError,
} from './live-node.js';
import {
  FailingUpdateReputationRegistryPort,
  FakeGraphPort,
  FakePaymentsPort,
  FakeRegistryPort,
  type FakePaymentsPortOptions,
} from './test-support/live-ports.js';

const PROVIDER_NAME = 'rugscore.assay.eth';
const CHALLENGER_ACCOUNT_ID = '0.0.777';

const manifest: Manifest = {
  capabilityId: 'echo',
  description: 'echoes a request back with its length as a fabricated claim, orchestration tests only',
  priceHbar: 5,
  endpoint: 'https://example.invalid/echo',
  bondRef: 'bond-seed',
  verifierHash: '0xseed',
};

type EchoVerify = Capability<string, { echoed: string }>['verify'];

/**
 * Trivial capability so these tests never depend on `@assay/cap-rugscore`,
 * which is being reshaped in a sibling issue. `verify` is injectable so the
 * `challenge` tests below can drive both a true and a lying verdict through
 * the same capability.
 */
function makeEchoCapability(verify?: EchoVerify): Capability<string, { echoed: string }> {
  return {
    id: 'echo',
    async run(req) {
      return { result: { echoed: req }, claims: [{ k: 'echoedLength', v: req.length, atBlock: 1 }] };
    },
    verify: verify ?? (async () => ({ valid: true })),
  };
}

function buildLiveNode(opts?: {
  reputation?: Partial<ProviderRecord['reputation']>;
  paymentsOpts?: FakePaymentsPortOptions;
  verify?: EchoVerify;
  challengerAccountId?: string;
  ensParentName?: string;
  candidateProviderNames?: string[];
  onLoopEvent?: (event: LoopEvent) => void | Promise<void>;
}) {
  const registry = new FakeRegistryPort().seed(PROVIDER_NAME, {
    manifest,
    reputation: { score: 80, jobs: 20, slashes: 0, bondHbar: 50, ...opts?.reputation },
  });
  const payments = new FakePaymentsPort(opts?.paymentsOpts);
  const graph = new FakeGraphPort();
  const capabilities = createCapabilityRegistry();
  capabilities.register(makeEchoCapability(opts?.verify));
  const jobs = createJobStore();

  const node = createLiveAssayNode({
    registry,
    payments,
    graph,
    capabilities,
    jobs,
    challengerAccountId: opts?.challengerAccountId ?? CHALLENGER_ACCOUNT_ID,
    ensParentName: opts?.ensParentName,
    candidateProviderNames: opts?.candidateProviderNames,
    onLoopEvent: opts?.onLoopEvent,
  });
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

    it('routes through AssayNode.discover, so a discover LoopEvent is actually emitted (issue #84 fix: this used to call registry.resolveProvider directly, bypassing the node and emitting nothing)', async () => {
      const events: LoopEvent[] = [];
      const { node } = buildLiveNode({ onLoopEvent: (event) => void events.push(event) });

      await node.discover(PROVIDER_NAME);

      const discoverEvents = events.filter((event) => event.step === 'discover');
      expect(discoverEvents).toHaveLength(1);
      expect(discoverEvents[0]).toMatchObject({ outcome: 'ok', name: PROVIDER_NAME });
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

    it('force: true still emits a "paid" LoopEvent for the real HBAR that left the account (issue #84 fix: this path calls payments.pay() directly and used to emit nothing)', async () => {
      const events: LoopEvent[] = [];
      const { node } = buildLiveNode({
        reputation: { jobs: 4, slashes: 2 },
        onLoopEvent: (event) => void events.push(event),
      });

      await node.payAndCall(PROVIDER_NAME, 'hello', true);

      const payEvents = events.filter((event) => event.step === 'pay');
      // no 'assessed' phase: the policy is deliberately skipped on force: true
      expect(payEvents.map((e) => (e as { phase: string }).phase)).not.toContain('assessed');
      expect(payEvents.map((e) => (e as { phase: string }).phase)).toContain('paid');
      const serveEvents = events.filter((event) => event.step === 'serve');
      expect(serveEvents).toHaveLength(1);
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
    it('a false claim: challenges and settles for real, slashing the bond and dropping reputation, returning the job "slashed"', async () => {
      const { node, payments, registry } = buildLiveNode({
        verify: async () => ({ valid: false, badClaim: 'echoedLength', reason: 'the length was fabricated' }),
      });
      const job = await node.payAndCall(PROVIDER_NAME, 'hello');

      const settled = await node.challenge(job.jobId, 'echoedLength');

      expect(settled.status).toBe('slashed');
      expect(settled.verdict).toEqual({
        valid: false,
        badClaim: 'echoedLength',
        reason: 'the length was fabricated',
      });
      expect(payments.slashCalls).toEqual([
        { bondRef: manifest.bondRef, toChallenger: CHALLENGER_ACCOUNT_ID },
      ]);
      const updated = await registry.resolveProvider(PROVIDER_NAME);
      expect(updated.reputation.score).toBeLessThan(80);
      expect(updated.reputation.slashes).toBe(1);
    });

    it('a valid claim: the challenge fails, raising reputation and never slashing, returning the job "settled"', async () => {
      const { node, payments, registry } = buildLiveNode();
      const job = await node.payAndCall(PROVIDER_NAME, 'hello');

      const settled = await node.challenge(job.jobId, 'echoedLength');

      expect(settled.status).toBe('settled');
      expect(payments.slashCalls).toEqual([]);
      const updated = await registry.resolveProvider(PROVIDER_NAME);
      expect(updated.reputation.score).toBeGreaterThan(80);
    });

    it('still surfaces a clear, named error if updateReputation itself fails, rather than a fake success', async () => {
      const registry = new FailingUpdateReputationRegistryPort({
        name: PROVIDER_NAME,
        manifest,
        reputation: { score: 80, jobs: 20, slashes: 0, bondHbar: 50 },
      });
      const payments = new FakePaymentsPort();
      const graph = new FakeGraphPort();
      const capabilities = createCapabilityRegistry();
      capabilities.register(makeEchoCapability());
      const jobs = createJobStore();
      const node = createLiveAssayNode({
        registry,
        payments,
        graph,
        capabilities,
        jobs,
        challengerAccountId: CHALLENGER_ACCOUNT_ID,
      });

      const job = await node.payAndCall(PROVIDER_NAME, 'hello');

      const error = await node.challenge(job.jobId, 'echoedLength').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ReputationUpdateFailedError);
      expect((error as Error).message).toMatch(/simulated ENS updateReputation write failure/);
      // the money/reputation-decision side already happened and was recorded truthfully
      // (this challenge held up, so no slash): only the ENS write failed.
      expect(jobs.get(job.jobId).status).toBe('settled');
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
      jobs.transition(job.jobId, 'challenged');

      await expect(node.rate(job.jobId, true)).rejects.toThrow(RateNotApplicableError);
    });

    it('bumps jobs and score by resolving the current reputation and writing the new totals, closing the job out as "settled"', async () => {
      const { node, registry } = buildLiveNode({ reputation: { jobs: 20, score: 80 } });
      const job = await node.payAndCall(PROVIDER_NAME, 'hello');

      const closed = await node.rate(job.jobId, true);

      expect(closed.status).toBe('settled');
      expect(closed.verdict).toBeUndefined();
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

    it('still surfaces a clear, named error if updateReputation itself fails, rather than a fake success', async () => {
      const registry = new FailingUpdateReputationRegistryPort({
        name: PROVIDER_NAME,
        manifest,
        reputation: { score: 80, jobs: 20, slashes: 0, bondHbar: 50 },
      });
      const payments = new FakePaymentsPort();
      const graph = new FakeGraphPort();
      const capabilities = createCapabilityRegistry();
      capabilities.register(makeEchoCapability());
      const jobs = createJobStore();
      const node = createLiveAssayNode({ registry, payments, graph, capabilities, jobs });

      const job = await node.payAndCall(PROVIDER_NAME, 'hello');

      await expect(node.rate(job.jobId, true)).rejects.toThrow(/simulated ENS updateReputation write failure/);
    });

    it('emits reputation LoopEvents sharing one strictly increasing seq with the node\'s own events (issue #84 fix: rate() lived outside AssayNode and emitted nothing at all)', async () => {
      const events: LoopEvent[] = [];
      const { node } = buildLiveNode({ onLoopEvent: (event) => void events.push(event) });
      const job = await node.payAndCall(PROVIDER_NAME, 'hello');
      events.length = 0; // only care about rate()'s own events from here

      await node.rate(job.jobId, true);

      const reputationPhases = events
        .filter((event) => event.step === 'reputation')
        .map((event) => (event as unknown as { progress: { phase: string } }).progress.phase);
      expect(reputationPhases).toEqual(['writing-reputation', 'reputation-confirmed', 'done']);
      // strictly increasing seq across every emitted event, not just within rate()'s own
      const seqs = events.map((event) => event.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
    });
  });

  describe('verifyClaim', () => {
    it('re-derives a claim through the real capability verify() and reports a true verdict, without moving the job', async () => {
      const { node } = buildLiveNode();
      const job = await node.payAndCall(PROVIDER_NAME, 'hello');

      const result = await node.verifyClaim(job.jobId, 'echoedLength');

      expect(result.verdict).toEqual({ valid: true });
      expect(result.claims).toEqual(job.claims);
      expect(result.jobId).toBe(job.jobId);
      expect(result.claimKey).toBe('echoedLength');
      // read-only: the job is still "served", verifyClaim never transitions it
      expect((await node.getJob(job.jobId)).status).toBe('served');
    });

    it('reports a false verdict for a tampered claim, still without moving the job (challenge is the committing action, not this)', async () => {
      const { node } = buildLiveNode({
        verify: async () => ({ valid: false, badClaim: 'echoedLength', reason: 'the length was fabricated' }),
      });
      const job = await node.payAndCall(PROVIDER_NAME, 'hello');

      const result = await node.verifyClaim(job.jobId, 'echoedLength');

      expect(result.verdict).toEqual({
        valid: false,
        badClaim: 'echoedLength',
        reason: 'the length was fabricated',
      });
      expect((await node.getJob(job.jobId)).status).toBe('served');
    });

    it('rejects an unknown claim key', async () => {
      const { node } = buildLiveNode();
      const job = await node.payAndCall(PROVIDER_NAME, 'hello');

      await expect(node.verifyClaim(job.jobId, 'noSuchClaim')).rejects.toThrow(/no claim/);
    });
  });

  describe('registerProvider', () => {
    const newManifest: Omit<Manifest, 'bondRef'> = {
      capabilityId: 'echo',
      description: 'a brand-new agent-registered echo provider',
      priceHbar: 3,
      endpoint: 'https://example.invalid/new-echo',
      verifierHash: '0xnew',
    };

    it('throws MissingEnsParentNameError when the node was not configured with one', async () => {
      const { node } = buildLiveNode();
      await expect(node.registerProvider('newagent', newManifest, 10)).rejects.toThrow(MissingEnsParentNameError);
    });

    it('throws InvalidProviderLabelError for a label containing a dot', async () => {
      const { node } = buildLiveNode({ ensParentName: 'assay.eth' });
      await expect(node.registerProvider('newagent.assay.eth', newManifest, 10)).rejects.toThrow(
        InvalidProviderLabelError,
      );
    });

    it('builds the full ENS name from the label and calls AssayNode.register() for real, reporting progress', async () => {
      const { node, registry, payments } = buildLiveNode({ ensParentName: 'assay.eth' });
      const progress: string[] = [];

      const result = await node.registerProvider('newagent', newManifest, 10, (p) => progress.push(p.phase));

      expect(result.name).toBe('newagent.assay.eth');
      expect(payments.postBondCalls).toEqual([10]);
      expect(progress).toEqual(['posting-bond', 'publishing-manifest', 'initializing-reputation', 'done']);
      const registered = await registry.resolveProvider('newagent.assay.eth');
      expect(registered.manifest).toEqual({ ...newManifest, bondRef: result.bondRef });
      expect(registered.reputation.bondHbar).toBe(10);
    });
  });

  describe('listProviders', () => {
    it('resolves every configured candidate, turning a resolve failure into a labelled miss rather than an error', async () => {
      const { node } = buildLiveNode({ candidateProviderNames: [PROVIDER_NAME, 'missing.assay.eth'] });

      const items = await node.listProviders();

      expect(items).toHaveLength(2);
      const hit = items.find((item) => item.name === PROVIDER_NAME)!;
      expect(hit.outcome).toBe('ok');
      expect(hit.outcome === 'ok' && hit.provider.manifest).toEqual(manifest);
      const miss = items.find((item) => item.name === 'missing.assay.eth')!;
      expect(miss.outcome).toBe('miss');
      expect(miss.outcome === 'miss' && miss.reason).toMatch(/missing.assay.eth/);
    });

    it('returns an empty list when no candidates are configured', async () => {
      const { node } = buildLiveNode();
      expect(await node.listProviders()).toEqual([]);
    });
  });

  describe('getJob / listJobs', () => {
    it('reads back a served job by id with no network call', async () => {
      const { node } = buildLiveNode();
      const job = await node.payAndCall(PROVIDER_NAME, 'hello');

      expect(await node.getJob(job.jobId)).toEqual(job);
    });

    it('throws for an unknown job id', async () => {
      const { node } = buildLiveNode();
      await expect(node.getJob('no-such-job')).rejects.toThrow(/Unknown job/);
    });

    it('lists every job created so far, in creation order', async () => {
      const { node } = buildLiveNode();
      expect(await node.listJobs()).toEqual([]);

      const first = await node.payAndCall(PROVIDER_NAME, 'hello');
      const second = await node.payAndCall(PROVIDER_NAME, 'hi');

      expect(await node.listJobs()).toEqual([first, second]);
    });
  });
});

/**
 * `createLiveAssayNode` — wires `@assay/core`'s real `createAssayNode` (issue
 * #20/#21) up to this app's `AssayNodePort` seam (issue #46). This is the one
 * file that turns "the MCP server can list its tools" into "the MCP server
 * actually pays on Hedera testnet, reads ENS on Sepolia, and reads The Graph
 * on mainnet", so every method here calls into a real adapter, never a fake.
 *
 * Two things this file does that `AssayNode` itself does not expose, both
 * documented at the point they happen rather than silently:
 *
 *  - `discover` returns the assessment alongside the raw record (see
 *    `node-port.ts`'s `DiscoverResult`), by calling the same exported,
 *    pure `assessProvider` the real `AssayNode.assess()` uses internally.
 *  - `payAndCall`'s `force: true` path bypasses `AssayNode`'s built-in pay
 *    policy on purpose. `AssayNode.payAndCall` has no override parameter (the
 *    policy check is baked into it), so honoring `force` means reimplementing
 *    its pay step here against the raw `PaymentsPort`, then handing off to
 *    `AssayNode.serve()` for the payment-gated part core still owns. This
 *    uses `@assay/core`'s exported `hashRequest`, so the memo it writes and the
 *    memo `serve()` checks can never drift apart
 *    — a small, known bit of drift risk flagged in the PR, not hidden here.
 *
 * `challenge` now that #26/#27 landed in core: it calls `AssayNode.challenge`
 * (verdict) then `AssayNode.settle` (slash-or-reputation-rise) and returns the
 * final job, `NodePort`'s documented contract. `@assay/registry`'s live ENS
 * adapter's `updateReputation` (#16) is implemented and wired in for real
 * (see `ens-registry.ts`), so a real challenge against it writes the
 * reputation change to Sepolia; if that write itself fails (RPC error,
 * out-of-range value, etc.) it still surfaces core's
 * `ReputationUpdateFailedError` rather than silently succeeding, same "fail
 * with a clear, named message" posture `rate` below has for the same reason.
 *
 * `rate` (issue #46's second open question) is implemented as far as the
 * existing core API allows — see its doc comment below for exactly what core
 * still owes it.
 */

import {
  assessProvider,
  createAssayNode,
  type AssayNodeConfig,
  type Job,
  type ProviderRecord,
  hashRequest,
} from '@assay/core';
import type { AssayNodePort, DiscoverResult } from './node-port.js';

export type LiveAssayNodeConfig = AssayNodeConfig;

/**
 * Thrown by `rate` when the job is not in a state `rate` applies to (SPEC.md
 * §3, §7): a job that has already been challenged, slashed, or settled has
 * already gone through the adversarial path, and closing it out again as
 * "unchallenged" would be a false reputation signal, not an honest one.
 */
export class RateNotApplicableError extends Error {
  readonly jobId: string;
  readonly status: Job['status'];

  constructor(jobId: string, status: Job['status']) {
    super(
      `Job "${jobId}" is "${status}", not "served": rate only applies to a served job nobody ` +
        'has challenged yet. Use challenge instead if you think a specific claim is false, ' +
        'or just note that this job is already closed out.',
    );
    this.name = 'RateNotApplicableError';
    this.jobId = jobId;
    this.status = status;
  }
}

/**
 * Builds the real `AssayNodePort` over live adapters. `config` is exactly
 * `@assay/core`'s `AssayNodeConfig`: the three ports plus the capability
 * registry (see `index.ts` for how those are constructed from the
 * environment).
 */
export function createLiveAssayNode(config: LiveAssayNodeConfig): AssayNodePort {
  const node = createAssayNode(config);
  const { registry, payments } = config;

  async function resolveAndAssess(name: string): Promise<DiscoverResult> {
    const provider: ProviderRecord = await registry.resolveProvider(name);
    return { provider, assessment: assessProvider(provider) };
  }

  return {
    async discover(capabilityId) {
      return resolveAndAssess(capabilityId);
    },

    async payAndCall(capabilityId, request, force = false) {
      if (!force) {
        // The real, gated path: `AssayNode.payAndCall` resolves the provider,
        // assesses it, applies the pay policy, and only then pays and serves.
        // `capabilityId` here is the ENS name (see `discover`'s doc comment);
        // core's own `capabilityId` param (the capability-registry key) is
        // read off the resolved manifest, not assumed to equal the ENS name.
        const provider = await registry.resolveProvider(capabilityId);
        const { job } = await node.payAndCall(capabilityId, provider.manifest.capabilityId, request);
        return job;
      }

      // force: true — deliberately bypasses the pay policy above (see the
      // module doc comment). Still a real Hedera testnet payment and a real
      // capability run: `serve()` still enforces the one gate that can never
      // be bypassed, `payments.confirm(txId)` (SPEC.md §12).
      const provider = await registry.resolveProvider(capabilityId);
      const requestHash = hashRequest(provider.manifest.capabilityId, request);
      const { txId } = await payments.pay(provider.manifest.priceHbar, requestHash);
      return node.serve({
        provider: capabilityId,
        capabilityId: provider.manifest.capabilityId,
        request,
        txId,
      });
    },

    async challenge(jobId, claimKey) {
      // `AssayNode.challenge` (#26) re-derives the claim through the
      // capability's real `verify()` and records the verdict; `AssayNode.settle`
      // (#27) then acts on it for real (a Hedera slash + ENS reputation drop,
      // or an ENS reputation rise on a failed challenge) and returns the final
      // job. Both are real calls against whatever ports this node was built
      // with, not simulated here.
      const verdict = await node.challenge(jobId, claimKey);
      return node.settle(jobId, verdict);
    },

    /**
     * Closes out a served, unchallenged job (issue #46's second open
     * question; SPEC.md §3, §7). #23's reading is confirmed here: this is
     * the non-adversarial complement to `challenge`, it never touches the
     * verifier or the bond, and it never awards a subjective rating, only
     * "this job completed without being disputed".
     *
     * What this can and cannot do against the *real* adapters today:
     *
     *  - It can and does check the job is actually `served` (not already
     *    challenged/slashed/settled) using `AssayNode`'s own `jobs` store.
     *  - It moves the job `served -> settled` with no `verdict`, through the
     *    `JobStore` transition #26/#27 added for exactly this (see
     *    `job-store.ts`'s doc comment on why "nobody challenged it" reuses
     *    `settled` rather than inventing a fifth status). Recorded *before*
     *    the ENS write below, same ordering `AssayNode.settle` uses and for
     *    the same reason: "this job was accepted, unchallenged" is true right
     *    now regardless of whether the reputation write below succeeds.
     *  - It then calls `registry.updateReputation(...)`, the real
     *    `RegistryPort` method this is supposed to drive. Against
     *    `@assay/registry`'s live ENS adapter (#16, implemented) that writes
     *    the reputation change to Sepolia for real; if the write itself fails
     *    (RPC error, out-of-range value, etc.) this file does not paper over
     *    that, it surfaces the underlying error, same "fail with a clear,
     *    named message on a real failure" posture `challenge` has.
     */
    async rate(jobId, satisfied, _comment) {
      const job = node.jobs.get(jobId);
      if (job.status !== 'served') {
        throw new RateNotApplicableError(jobId, job.status);
      }

      // `updateReputation`'s `delta` reads, from `@assay/registry`'s own
      // `FakeRegistryPort` (the only concrete semantics written down so
      // far), as an absolute patch merged onto the existing reputation, not
      // a mathematical increment — so the new totals are computed here off
      // a fresh read, not guessed as `{ jobs: 1 }`.
      const current = await registry.resolveProvider(job.provider);
      const closed = node.jobs.transition(jobId, 'settled');
      await registry.updateReputation(job.provider, {
        jobs: current.reputation.jobs + 1,
        score: satisfied ? current.reputation.score + 1 : current.reputation.score,
      });

      return closed;
    },
  };
}

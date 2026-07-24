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
 *    duplicates `node.ts`'s private `hashRequest` (three lines, not exported)
 *    — a small, known bit of drift risk flagged in the PR, not hidden here.
 *
 * `rate` and `challenge` are the two tools this file cannot fully wire for
 * real, and it does not pretend otherwise:
 *
 *  - `challenge` delegates straight to `AssayNode.challenge`, which always
 *    rejects until #26 lands (SPEC.md, node.ts). Nothing to add here.
 *  - `rate` (issue #46's second open question) is implemented as far as the
 *    existing core API allows — see its doc comment below for exactly what
 *    core still owes it.
 */

import { createHash } from 'node:crypto';
import {
  assessProvider,
  createAssayNode,
  type AssayNodeConfig,
  type Job,
  type ProviderRecord,
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
 * Duplicated from `@assay/core/node.ts`'s private `hashRequest`, which is not
 * exported. Deterministic and dependency-free (`node:crypto` is a Node
 * builtin), so the duplication is low-risk, but it is still duplication: if
 * `AssayNode.payAndCall`'s hashing ever changes, this needs to change with
 * it. The real fix is for core to export `hashRequest` (or accept a per-call
 * policy override so `force` would not need to reimplement the pay step at
 * all) — flagged in the PR as owed, not fixed here per the instruction not to
 * add to `packages/core` while #49 is in flight there.
 */
function hashRequest(capabilityId: string, request: unknown): string {
  return createHash('sha256').update(JSON.stringify({ capabilityId, request })).digest('hex');
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
      // `AssayNode.challenge` always rejects until #26 lands (it names the
      // issue in its own message); this line never returns normally, but
      // await lets that rejection propagate instead of this function
      // resolving with `undefined` cast to `Job`.
      await node.challenge(jobId, claimKey);
      throw new Error('unreachable: AssayNode.challenge always rejects until #26 lands');
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
     *    challenged/slashed/settled) using `AssayNode`'s own `jobs` store —
     *    no core change needed for that, `JobStore.get` already exists.
     *  - It then calls `registry.updateReputation(...)`, the real
     *    `RegistryPort` method this is supposed to drive. Against
     *    `@assay/registry`'s live ENS adapter that call throws today
     *    ("updateReputation is tracked in #16") — this file does not paper
     *    over that; it is the same "fail with a clear, named message until
     *    the tracked issue lands" posture `challenge` already has for #26.
     *  - What core does *not* have, and what I did not add per the
     *    instruction not to touch `packages/core` while #49 is in flight
     *    there: a `JobStore` transition that takes a `served` job to a
     *    closed/rated terminal state. `ALLOWED_TRANSITIONS` in
     *    `job-store.ts` only allows `served -> challenged`; there is no
     *    `served -> settled` (or any other) move for a job nobody
     *    challenged. So even once #16 lands, a rated job's `status` stays
     *    `"served"` here — core still owes either a new transition (e.g.
     *    `served -> settled` with no verdict) or a dedicated terminal
     *    status for this path. Documented in the PR, not invented here.
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
      await registry.updateReputation(job.provider, {
        jobs: current.reputation.jobs + 1,
        score: satisfied ? current.reputation.score + 1 : current.reputation.score,
      });

      return job;
    },
  };
}

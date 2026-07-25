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
 *
 * Issue #84 adds `verifyClaim`, `registerProvider`, `listProviders`, `getJob`
 * and `listJobs`, all wired against real `@assay/core` behaviour (never
 * reimplemented): `verifyClaim` and `getJob`/`listJobs` are thin pass
 * throughs to `AssayNode.verifyClaim` and `AssayNode.jobs`; `registerProvider`
 * calls `AssayNode.register()` after turning a bare label into a full ENS
 * name; `listProviders` resolves a configured candidate list through the
 * same `discover` path above, one candidate's failure never sinking the rest.
 * The same #83 design-review finding this file's `discover` doc comment
 * above already fixed (calling `registry.resolveProvider` directly instead
 * of routing through the node, emitting no LoopEvent) is what every one of
 * these new methods is written to avoid from the start.
 *
 * `payAndCall`'s `force: true` path gets the same kind of fix (same review,
 * same root cause): it calls `payments.pay()` directly against the raw port
 * (see this method's own doc comment for why), so without this it would
 * never emit the `{step:'pay', phase:'paid'}` LoopEvent -- real HBAR moving
 * with nothing narrating it. `serve()` right after is not bypassed, so its
 * own confirming/confirmed/serve/accept events are unaffected either way.
 *
 * `rate` also gets a fix here (same review, same root cause): it lives
 * outside `AssayNode` entirely (see its own doc comment for why -- core has
 * no `rate` verb), so it could never emit a `LoopEvent` and was invisible to
 * the live dashboard no matter what. It now synthesizes one, reusing the
 * existing `SettlementLoopEvent`/`SettleProgress` shape rather than inventing
 * a new one: `rate`'s reputation write is, in narration terms, exactly
 * `settle()`'s valid-verdict "reputation" leg (writing-reputation ->
 * reputation-confirmed/-failed -> done), so a dashboard that already renders
 * that step renders this correctly with no changes of its own. This needs no
 * change to `@assay/core` -- `createEventStamper()` is shared with the node
 * below (passed in as `eventStamper`) so `rate`'s synthetic events interleave
 * with the node's own real ones under one strictly increasing `seq`, per
 * `createEventStamper`'s own doc comment on exactly this composition-root
 * case.
 */

import {
  assessProvider,
  createAssayNode,
  createEventStamper,
  type AssayNodeConfig,
  type Job,
  type LoopEvent,
  type LoopEventVariant,
  type ProviderRecord,
  type RegisterProgress,
  hashRequest,
} from '@assay/core';
import type {
  AssayNodePort,
  ProviderListItem,
  RegisterProviderResult,
  VerifyClaimResult,
} from './node-port.js';

export type LiveAssayNodeConfig = AssayNodeConfig & {
  /**
   * The Assay parent ENS name (e.g. `"assay.eth"`) subnames register under
   * (issue #84). Only `registerProvider` needs this: it turns a bare label
   * into the full name `"<label>.<ensParentName>"`. Every other
   * `AssayNodePort` method works fine without it. Optional so existing
   * callers/tests that never call `registerProvider` need not supply it;
   * `registerProvider` throws `MissingEnsParentNameError` if it is absent
   * when actually called.
   */
  ensParentName?: string;
  /**
   * The candidate provider names `listProviders` resolves (issue #84). ENS
   * cannot be enumerated, so this is the one place "discovery" gets a real
   * set to compare rather than a single hardcoded name. Defaults to an empty
   * list (so `listProviders()` resolves to `[]`) when not provided.
   */
  candidateProviderNames?: string[];
};

/**
 * Thrown by `registerProvider` when this node was not configured with
 * `ensParentName` (issue #84): without it there is no parent name to build
 * the full ENS subname from, and posting a real bond against a name we could
 * not construct would be worse than refusing up front.
 */
export class MissingEnsParentNameError extends Error {
  constructor() {
    super(
      'registerProvider requires "ensParentName" to be configured on this node (the Assay ' +
        'parent ENS name subnames register under, e.g. "assay.eth"). Pass it in LiveAssayNodeConfig.',
    );
    this.name = 'MissingEnsParentNameError';
  }
}

/**
 * Thrown by `registerProvider` when `label` is not a bare subname label
 * (issue #84): it must not itself contain a dot, since the full ENS name is
 * built automatically as `"<label>.<ensParentName>"` -- a label that already
 * looks like a full name is almost certainly a caller mistake, not something
 * to silently double up on.
 */
export class InvalidProviderLabelError extends Error {
  readonly label: string;

  constructor(label: string) {
    super(
      `"${label}" is not a valid subname label: it must not contain "." -- pass just the label ` +
        '(e.g. "myagent"), not a full ENS name; the full name is built automatically.',
    );
    this.name = 'InvalidProviderLabelError';
    this.label = label;
  }
}

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
  // Relays registerProvider's per-call onProgress callback (issue #84)
  // through the one onRegisterProgress hook createAssayNode's config takes
  // at construction time. `activeRegisterListener` is set right before
  // register() is invoked and cleared in a `finally` right after (see
  // registerProvider below): safe under this build's single-caller-at-a-time
  // usage, same disclosed simplification the rest of this file already makes
  // for the single-operator Hedera account.
  let activeRegisterListener: ((progress: RegisterProgress) => void) | undefined;

  // Shared across the node's own emitted events and rate()'s synthetic ones
  // (see the module doc comment): one `createEventStamper()`, passed into
  // `createAssayNode` as `eventStamper` and reused directly below, so `seq`
  // stays strictly increasing across both sources.
  const stamp = config.eventStamper ?? createEventStamper();

  const node = createAssayNode({
    ...config,
    eventStamper: stamp,
    onRegisterProgress(progress) {
      config.onRegisterProgress?.(progress);
      activeRegisterListener?.(progress);
    },
  });
  const { registry, payments } = config;

  // Mirrors core's own `safeEmit` (node.ts, not exported): narration must
  // never break the loop here either. `rate()` is the only caller.
  function emitLoopEvent(body: LoopEventVariant): void {
    if (!config.onLoopEvent) return;
    const event: LoopEvent = stamp(body);
    try {
      const outcome = config.onLoopEvent(event);
      if (outcome && typeof (outcome as Promise<void>).then === 'function') {
        (outcome as Promise<void>).catch(() => {});
      }
    } catch {
      // Deliberately silent -- see AssayNodeConfig.onLoopEvent's doc comment.
    }
  }

  return {
    async discover(capabilityId) {
      // Routes through `AssayNode.discover` (fix for the design-review
      // finding on #83: this used to call `registry.resolveProvider`
      // directly, bypassing the node entirely and emitting no `discover`
      // LoopEvent -- invisible to the live dashboard). `assessProvider` is
      // the same pure, exported function `AssayNode.assess()` uses
      // internally, applied here over the already-resolved record instead of
      // a second `resolveProvider` call.
      const provider: ProviderRecord = await node.discover(capabilityId);
      return { provider, assessment: assessProvider(provider) };
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
      // Same class of bypass #83's design review flagged on `discover`
      // (issue #84): `payments.pay()` here is called directly against the
      // raw port, not through `AssayNode.payAndCall`, so it would otherwise
      // never emit the `{step:'pay', phase:'paid'}` LoopEvent real money
      // actually moving deserves -- invisible to the live dashboard even
      // though HBAR really left the account. `node.serve()` right after this
      // still emits its own real confirming/confirmed/serve/accept events,
      // since `serve()` itself is not bypassed here, only the pay/decline
      // policy step is.
      emitLoopEvent({ step: 'pay', phase: 'paid', name: capabilityId, txId, amountHbar: provider.manifest.priceHbar });
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
     *
     * Narrated since issue #84 (see the module doc comment): the reputation
     * write below emits the same `SettlementLoopEvent` shape `settle()`'s
     * valid-verdict path does (`step: 'reputation'`), just synthesized here
     * rather than inside `AssayNode`, since core has no `rate` verb for it to
     * live on.
     */
    async rate(jobId, satisfied, _comment) {
      const job = node.jobs.get(jobId);
      if (job.status !== 'served') {
        throw new RateNotApplicableError(jobId, job.status);
      }

      const start = Date.now();
      const elapsed = () => Date.now() - start;

      // `updateReputation`'s `delta` reads, from `@assay/registry`'s own
      // `FakeRegistryPort` (the only concrete semantics written down so
      // far), as an absolute patch merged onto the existing reputation, not
      // a mathematical increment — so the new totals are computed here off
      // a fresh read, not guessed as `{ jobs: 1 }`.
      const current = await registry.resolveProvider(job.provider);
      const closed = node.jobs.transition(jobId, 'settled');

      emitLoopEvent({
        step: 'reputation',
        progress: { phase: 'writing-reputation', elapsedMs: elapsed() },
        before: current.reputation,
      });

      try {
        const { txHash, reputation } = await registry.updateReputation(job.provider, {
          jobs: current.reputation.jobs + 1,
          score: satisfied ? current.reputation.score + 1 : current.reputation.score,
        });
        emitLoopEvent({
          step: 'reputation',
          progress: { phase: 'reputation-confirmed', elapsedMs: elapsed(), txHash, reputation },
          before: current.reputation,
        });
      } catch (cause) {
        emitLoopEvent({
          step: 'reputation',
          progress: { phase: 'reputation-failed', elapsedMs: elapsed() },
          before: current.reputation,
        });
        emitLoopEvent({ step: 'reputation', progress: { phase: 'done', elapsedMs: elapsed(), job: closed } });
        // Unlike settle(), rate() has never wrapped this in a named error
        // (see this method's doc comment: it "surfaces the underlying
        // error" as-is) -- narration does not change that contract.
        throw cause;
      }

      emitLoopEvent({ step: 'reputation', progress: { phase: 'done', elapsedMs: elapsed(), job: closed } });
      return closed;
    },

    /**
     * Read-only sibling of `challenge` (issue #84): calls `AssayNode.verifyClaim`
     * for the real re-derivation and verdict, then attaches the job's full
     * claim set (a second, cheap in-memory `jobs.get`, no extra network call)
     * so the tool layer can show what was claimed next to what the chain
     * says, without hardcoding any signal name.
     */
    async verifyClaim(jobId, claimKey): Promise<VerifyClaimResult> {
      const verdict = await node.verifyClaim(jobId, claimKey);
      const job = node.jobs.get(jobId);
      return { jobId, claimKey, claims: job.claims, verdict };
    },

    /**
     * Agent self-onboarding (issue #84): turns a bare `label` into the full
     * ENS name and calls `AssayNode.register()` for the real bond-then
     * -manifest-then-reputation sequence (never reimplemented here -- see
     * `AssayNode.register`'s own doc comment for why the ordering is forced).
     * `onProgress`, if given, is wired to the same `onRegisterProgress` tick
     * stream `AssayNodeConfig` already reports through (see
     * `activeRegisterListener` above), so the tool layer can narrate this
     * call's own ~25s without a second, parallel progress mechanism.
     */
    async registerProvider(label, manifest, bondHbar, onProgress): Promise<RegisterProviderResult> {
      if (!config.ensParentName) {
        throw new MissingEnsParentNameError();
      }
      if (label.includes('.')) {
        throw new InvalidProviderLabelError(label);
      }
      const name = `${label}.${config.ensParentName}`;

      activeRegisterListener = onProgress;
      try {
        const result = await node.register({ name, manifest, bondHbar });
        return { name, ...result };
      } finally {
        activeRegisterListener = undefined;
      }
    },

    /**
     * Resolves every configured candidate name through the same `discover`
     * path above (issue #84), one candidate's failure turned into a
     * clearly-labelled miss rather than failing the whole call. Runs the
     * resolves concurrently: each is an independent read (real ENS or
     * whatever `registry` this node was built with), so there is no ordering
     * dependency between them to preserve.
     */
    async listProviders(): Promise<ProviderListItem[]> {
      const names = config.candidateProviderNames ?? [];
      return Promise.all(
        names.map(async (name): Promise<ProviderListItem> => {
          try {
            const provider = await node.discover(name);
            return { name, outcome: 'ok', provider, assessment: assessProvider(provider) };
          } catch (error) {
            return { name, outcome: 'miss', reason: error instanceof Error ? error.message : String(error) };
          }
        }),
      );
    },

    /** Thin, read-only pass-through to `AssayNode.jobs.get` (issue #84): no network call, `UnknownJobError` propagates as-is. */
    async getJob(jobId): Promise<Job> {
      return node.jobs.get(jobId);
    },

    /** Thin, read-only pass-through to `AssayNode.jobs.list` (issue #84): no network call. */
    async listJobs(): Promise<Job[]> {
      return node.jobs.list();
    },
  };
}

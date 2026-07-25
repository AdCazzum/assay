/**
 * `createAssayNode` — the loop from SPEC.md §7, wired over the three port
 * seams (`RegistryPort`, `PaymentsPort`, `GraphPort`) and the capability
 * runtime. This is the rail: it orchestrates adapters and never touches a
 * concrete network client, and it knows nothing about rug-score (that
 * knowledge lives entirely inside whatever `Capability` the caller
 * registers).
 *
 * `challenge()`/`settle()` (#26/#27) close the loop: a served job can be
 * disputed, routed through the capability's own `verify()` (the runtime
 * never knows what it checks), and the verdict settled for real — a Hedera
 * slash or an ENS reputation rise, per SPEC.md §7 steps 6-8.
 */

import { createHash } from 'node:crypto';
import { assessProvider, type ProviderAssessment } from './assessment.js';
import { createJobStore, type JobStore } from './job-store.js';
import type { GraphPort, PaymentsPort, RegistryPort } from './ports.js';
import {
  DEFAULT_PAY_DECISION_POLICY,
  evaluatePayDecision,
  PayDeclinedError,
  type PayDecisionPolicyConfig,
} from './pay-policy.js';
import {
  computeChallengeFailedReputationDelta,
  computeSlashReputationDelta,
  DEFAULT_SETTLEMENT_POLICY,
  type SettlementPolicyConfig,
} from './settlement-policy.js';
import type { CapabilityRegistry } from './runtime.js';
import type { Job, JobStatus, Manifest, ProviderRecord, Reputation, Verdict } from './types.js';

/**
 * Thrown by `serve()` when the payment does not check out. SPEC.md §12
 * forbids serving on an unconfirmed or failed payment, and `serve()` checks
 * this itself, unconditionally, before running the capability or touching
 * the job store.
 *
 * What "checks out" means depends on what `payments` (the `PaymentsPort`)
 * implements: if it has `confirmPayment`, this fires when the transaction
 * never finalized as SUCCESS, when the confirmed amount was below
 * `manifest.priceHbar`, or when its memo did not match this exact
 * `capabilityId`/`request` (closing hedera-F1: previously any SUCCESS txId,
 * for any amount, memo, or recipient — even one already spent on a prior job
 * — unlocked `serve()`). If `payments` only implements the older, bare
 * `confirm(txId)`, this fires only when that returns `false`, same as before
 * this fix — that narrower gate is a known, disclosed limitation of a
 * `PaymentsPort` that has not adopted `confirmPayment` yet, not something
 * this error hides.
 *
 * A payment transaction id being reused against a second job is a separate
 * failure, `DuplicatePaymentTxError` from the job store (see `job-store.ts`),
 * thrown after this check passes.
 */
export class PaymentNotConfirmedError extends Error {
  readonly txId: string;

  constructor(txId: string) {
    super(`Payment "${txId}" is not confirmed; refusing to serve.`);
    this.name = 'PaymentNotConfirmedError';
    this.txId = txId;
  }
}

/**
 * Thrown by `challenge()` when `jobId` is not currently `served`. Checked
 * before `verify()` ever runs, so a job that was already challenged (or
 * settled/slashed) is rejected without spending a second verifier call —
 * this is what makes challenging the same claim twice a clean no-op-with-error
 * rather than a second, wasted re-derivation.
 */
export class JobNotChallengeableError extends Error {
  readonly jobId: string;
  readonly status: JobStatus;

  constructor(jobId: string, status: JobStatus) {
    super(`Job "${jobId}" is "${status}", not "served": only a served job can be challenged.`);
    this.name = 'JobNotChallengeableError';
    this.jobId = jobId;
    this.status = status;
  }
}

/** Thrown by `challenge()` when `claimKey` names no claim the job actually carries. */
export class UnknownClaimError extends Error {
  readonly jobId: string;
  readonly claimKey: string;
  readonly knownKeys: readonly string[];

  constructor(jobId: string, claimKey: string, knownKeys: readonly string[]) {
    super(
      `Job "${jobId}" carries no claim "${claimKey}". Known claims: ${
        knownKeys.length > 0 ? knownKeys.join(', ') : '(none)'
      }.`,
    );
    this.name = 'UnknownClaimError';
    this.jobId = jobId;
    this.claimKey = claimKey;
    this.knownKeys = knownKeys;
  }
}

/**
 * Thrown by `settle()` when `jobId` is not currently `challenged`. This is
 * the guard that makes double-settle safe: once a job moves to `slashed` or
 * `settled` (both terminal, see job-store.ts), a second `settle()` call is
 * rejected here before it ever touches `payments.slash()` again.
 */
export class JobNotSettleableError extends Error {
  readonly jobId: string;
  readonly status: JobStatus;

  constructor(jobId: string, status: JobStatus) {
    super(`Job "${jobId}" is "${status}", not "challenged": only a challenged job can be settled.`);
    this.name = 'JobNotSettleableError';
    this.jobId = jobId;
    this.status = status;
  }
}

/**
 * Thrown by `settle()` on an invalid verdict when the node was not
 * configured with `challengerAccountId` (SPEC.md §4: `slash(bondRef,
 * toChallenger)` needs somewhere real to send the slashed HBAR to). Thrown
 * before any transaction is attempted, so the job stays `challenged` and a
 * retry after fixing the config is safe.
 */
export class MissingChallengerAccountError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(
      `Cannot settle job "${jobId}" as invalid: no "challengerAccountId" was configured on this ` +
        'node, so there is nowhere real to send the slashed bond. Pass one in AssayNodeConfig.',
    );
    this.name = 'MissingChallengerAccountError';
    this.jobId = jobId;
  }
}

/**
 * Thrown by `settle()` when a second call for the same `jobId` arrives while
 * the first is still in flight (see the `settlingJobIds` guard in
 * `createAssayNode`). Distinct from `JobNotSettleableError`, which is about
 * the job's *durable* status; this is about a concurrent call racing the gap
 * between the pre-check and the first `await` — the job's own status may
 * still read `challenged` when this fires.
 */
export class SettlementInProgressError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`Job "${jobId}" is already being settled by another in-flight call.`);
    this.name = 'SettlementInProgressError';
    this.jobId = jobId;
  }
}

/**
 * Thrown by `settle()` when the money side (the Hedera slash, or simply
 * deciding the provider is vindicated) has already happened and been
 * recorded on the job, but the follow-up ENS reputation write then failed.
 * SPEC.md §9 is explicit that orchestration across the three networks is
 * off-chain and not atomic: this error is that honesty made concrete. The
 * job's `status` (`slashed` or `settled`) and `verdict` are already correct
 * and durable in the store by the time this is thrown; only the ENS
 * reputation side effect still needs a retry (e.g. re-driving
 * `registry.updateReputation` directly with the same delta).
 *
 * On the invalid-verdict path (see `settle()`'s doc comment on why the slash
 * and the ENS write now run concurrently, #53) this is only ever thrown when
 * the slash itself *succeeded*: the job's `status` is real, durable
 * `"slashed"` by the time this is constructed, exactly as before concurrency
 * was introduced.
 */
export class ReputationUpdateFailedError extends Error {
  readonly jobId: string;
  readonly job: Job;
  override readonly cause?: unknown;

  constructor(jobId: string, job: Job, cause: unknown) {
    super(
      `Job "${jobId}" settled as "${job.status}" (that part is real and durable), but the ENS ` +
        `reputation write for "${job.provider}" failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }. The job status is truthful; the reputation write needs a retry.`,
    );
    this.name = 'ReputationUpdateFailedError';
    this.jobId = jobId;
    this.job = job;
    this.cause = cause;
  }
}

/**
 * What the ENS reputation write (fired concurrently with the Hedera slash,
 * see `settle()`) did, carried on `SlashFailedError` so a caller reading
 * "the slash failed" also learns whether the concurrent write already landed.
 */
export type ConcurrentReputationOutcome =
  | { outcome: 'succeeded'; txHash: string; reputation: Reputation }
  | { outcome: 'failed'; cause: unknown };

/**
 * Thrown by `settle()` on an invalid verdict when `payments.slash()` itself
 * fails. Money never moved, so the job is left exactly as it was (still
 * `"challenged"`), same as before this file ran the slash and the ENS write
 * concurrently — a retry is always safe on the *job's* side.
 *
 * What is new since #53 (running the two legs concurrently to cut the
 * post-verdict tail from ~17s to ~12.5s, see `settle()`'s doc comment): the
 * ENS reputation write is no longer gated on the slash succeeding, so it can
 * land even when the slash does not. `reputationWrite` names which of the
 * two ways that goes:
 *
 *  - `{ outcome: 'failed' }` — nothing changed anywhere. The job stays
 *    `"challenged"` and a plain retry of `settle()` is exactly as safe as it
 *    always was.
 *  - `{ outcome: 'succeeded' }` — ENS now shows a slash that did not actually
 *    happen on Hedera (ahead of the money, not behind it). The job still
 *    correctly stays `"challenged"` (nothing here pretends a slash happened
 *    when it did not), but `"${providerName}"`'s published reputation is
 *    temporarily inconsistent with the real Hedera state until this is
 *    reconciled by hand or the slash is retried and lands for real. A later
 *    `settle()` retry that then succeeds will compute its reputation delta
 *    from whatever ENS holds *at that time* (already including this write),
 *    so it will not silently double the penalty — but the ENS record between
 *    now and that retry is honestly stale, not honestly current, and this
 *    error is what says so.
 */
export class SlashFailedError extends Error {
  readonly jobId: string;
  readonly providerName: string;
  readonly reputationWrite: ConcurrentReputationOutcome;
  override readonly cause: unknown;

  constructor(jobId: string, providerName: string, cause: unknown, reputationWrite: ConcurrentReputationOutcome) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    const reputationNote =
      reputationWrite.outcome === 'succeeded'
        ? ` The concurrent ENS reputation write for "${providerName}" already succeeded (tx ` +
          `"${reputationWrite.txHash}"), so ENS now shows a slash that did not actually happen on ` +
          'Hedera -- reconcile by hand, or retry settle(): a successful retry will compute its delta ' +
          'off the reputation ENS already holds, not off the pre-write value.'
        : ' The concurrent ENS reputation write also failed, so nothing changed anywhere; the job ' +
          'stays "challenged" and a retry is safe.';
    super(
      `Job "${jobId}"'s Hedera slash failed for "${providerName}": ${causeMessage}.${reputationNote}`,
    );
    this.name = 'SlashFailedError';
    this.jobId = jobId;
    this.providerName = providerName;
    this.cause = cause;
    this.reputationWrite = reputationWrite;
  }
}

/**
 * Thrown by `register()` when `payments.postBond()` already succeeded (real
 * HBAR left the operator account, `bondRef`/`bondTxId` are real) but the
 * follow-up `registry.publishManifest()` then failed. SPEC.md §9: the two
 * networks are not one atomic transaction, so this names the honest
 * in-between state plainly rather than swallowing it — the provider is
 * **bonded but unlisted**.
 *
 * The bond already happened for real, so **do not call `register()` again**:
 * that would post a *second*, redundant bond for the same provider. Instead,
 * once whatever ENS failure caused this is fixed, retry by calling
 * `registry.publishManifest(name, manifest)` directly with this error's own
 * `manifest` (it already carries the real `bondRef` this bond produced), then
 * `registry.updateReputation(name, { bondHbar })` to finish the
 * reputation-init step `register()` never got to.
 */
export class ManifestPublishFailedError extends Error {
  readonly providerName: string;
  readonly bondRef: string;
  readonly bondTxId: string;
  readonly manifest: Manifest;
  override readonly cause?: unknown;

  constructor(providerName: string, bondRef: string, bondTxId: string, manifest: Manifest, cause: unknown) {
    super(
      `register("${providerName}") posted a real bond (bondRef "${bondRef}", tx "${bondTxId}") but the ` +
        `ENS manifest publish then failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }. The bond already happened; do not call register() again (it would post a second bond) -- ` +
        `retry registry.publishManifest() directly with this error's "manifest" (it already carries the ` +
        'real bondRef), then registry.updateReputation() to finish reputation init.',
    );
    this.name = 'ManifestPublishFailedError';
    this.providerName = providerName;
    this.bondRef = bondRef;
    this.bondTxId = bondTxId;
    this.manifest = manifest;
    this.cause = cause;
  }
}

/**
 * Thrown by `register()` when the bond posted and the manifest published
 * (both real, both durable) but the reputation-initialization write then
 * failed. SPEC.md §9's "not atomic across networks" made concrete again: the
 * provider is now **listed but not yet discoverable** — `resolveProvider()`
 * requires `assay:rep` to exist (`MissingRecordError`), and this is the one
 * write that creates it, so `discover()`/`payAndCall()` against this name
 * will fail until it lands.
 *
 * Same recovery rule as `ManifestPublishFailedError`: do not call
 * `register()` again (it would post a second bond). Retry
 * `registry.updateReputation(name, { bondHbar })` directly once the
 * underlying ENS failure is fixed.
 */
export class ReputationInitFailedError extends Error {
  readonly providerName: string;
  readonly manifestTxHash: string;
  readonly bondRef: string;
  readonly bondTxId: string;
  override readonly cause?: unknown;

  constructor(
    providerName: string,
    manifestTxHash: string,
    bondRef: string,
    bondTxId: string,
    cause: unknown,
  ) {
    super(
      `register("${providerName}") posted the bond (bondRef "${bondRef}", tx "${bondTxId}") and published ` +
        `the manifest (tx "${manifestTxHash}") but the reputation-initialization write then failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }. The provider is listed but not yet discoverable (resolveProvider() requires assay:rep to ` +
        'exist) -- do not call register() again (it would post a second bond); retry ' +
        'registry.updateReputation(name, { bondHbar }) directly.',
    );
    this.name = 'ReputationInitFailedError';
    this.providerName = providerName;
    this.manifestTxHash = manifestTxHash;
    this.bondRef = bondRef;
    this.bondTxId = bondTxId;
    this.cause = cause;
  }
}

export type AssayNodeConfig = {
  registry: RegistryPort;
  payments: PaymentsPort;
  /**
   * Threaded through so a capability's own `run`/`verify` can close over it
   * at construction time (see `@assay/cap-rugscore`'s
   * `createRugScoreCapability`). The loop implemented here (register /
   * discover / payAndCall / serve / challenge / settle) never calls it
   * directly: `challenge()` routes to the capability's `verify()` through
   * the capability runtime, which re-derives claims from The Graph itself.
   */
  graph: GraphPort;
  capabilities: CapabilityRegistry;
  /** Overridable so callers (and tests) can inject or inspect the job store. Defaults to a fresh in-memory one. */
  jobs?: JobStore;
  /**
   * The pay/decline floor `payAndCall` applies to `discover()`'s result
   * before it ever calls `payments.pay()` (issue #21, SPEC.md §16 risk 5).
   * This is a fallback for non-agent callers, not the demo's actual
   * reasoning: a real agent driving the loop via MCP (#46) reads the
   * `ProviderAssessment` itself and reasons out loud, using `assess()` below
   * for material rather than being bound by this policy's verdict. Defaults
   * to `DEFAULT_PAY_DECISION_POLICY`; every threshold on it is documented as
   * tunable in `pay-policy.ts`.
   */
  payPolicy?: PayDecisionPolicyConfig;
  /**
   * Who `settle()` pays a slash to (`payments.slash(bondRef, toChallenger)`,
   * SPEC.md §4/§7 step 7): a Hedera account id string. Only required if
   * `settle()` is ever called with an invalid verdict; a missing value fails
   * loudly with `MissingChallengerAccountError` rather than guessing an
   * account. In this single-operator hackathon build there is one funded
   * testnet account acting as both requester and watchdog (the same
   * disclosed simplification `packages/payments/scripts/bond-slash.ts`
   * makes), so this is typically the operator's own account id.
   */
  challengerAccountId?: string;
  /**
   * The reputation math `settle()` applies to a verdict (issue #27). Every
   * field is documented as tunable in `settlement-policy.ts`. Defaults to
   * `DEFAULT_SETTLEMENT_POLICY`.
   */
  settlementPolicy?: SettlementPolicyConfig;
  /**
   * Observability hook for `register()` (SPEC.md §7 step 1), the slowest
   * step in the demo (a real ~4s Hedera bond, then a real ~12.5s ENS
   * manifest write, then a real ~12.5s ENS reputation write, back to back).
   * Follows the same precedent already set for the other two slow legs
   * rather than inventing a third shape: `@assay/payments`'s
   * `onConfirmAttempt` and `@assay/registry`'s `onReputationWriteAttempt`
   * are both bound once at adapter-construction time and both report
   * progress ticks, not just a final result. This hook is the core-level
   * equivalent, bound once per node, reporting `register()`'s own
   * phase-to-phase progress (see `RegisterProgress`) so the dashboard can
   * narrate which of the three real transactions is currently in flight.
   */
  onRegisterProgress?: (info: RegisterProgress) => void;
  /**
   * Observability hook for `settle()` (issue #53). The two real legs it can
   * run — `payments.slash()` (~4.1s measured) and `registry.updateReputation()`
   * (~12.5s measured, three live samples so far) — start at the same time on
   * an invalid verdict (see `settle()`'s doc comment on why), so a caller
   * narrating this needs to know when *each* leg starts and finishes, not
   * just one combined phase. `@assay/registry`'s own `onReputationWriteAttempt`
   * (bound once at `createEnsRegistry` construction, same precedent as
   * `onRegisterProgress` above) still fires for the ENS write's own
   * submitted/pending-heartbeat/confirmed ticks; this hook is the settle-level
   * complement, reporting when the write starts and how it (and the slash)
   * concluded, so the dashboard's `slash` and `reputation` steps can both
   * render `running` concurrently instead of the second one staying frozen
   * until the first finishes.
   */
  onSettleProgress?: (info: SettleProgress) => void;
};

export type RegisterInput = {
  name: string;
  /**
   * Every manifest field except `bondRef`. `bondRef` is deliberately not
   * accepted here: `register()` fills it in from the real
   * `payments.postBond()` result, because the bond must be posted *before*
   * the manifest is written (see `register()`'s doc comment on `AssayNode`
   * for why the ordering is forced, not a style choice).
   */
  manifest: Omit<Manifest, 'bondRef'>;
  bondHbar: number;
};

export type RegisterResult = {
  bondRef: string;
  bondTxId: string;
  manifestTxHash: string;
  reputationTxHash: string;
  /** The reputation record as written: `{ score: 0, jobs: 0, slashes: 0 }` on a name's first-ever registration (matching `assessment.ts`'s "unproven" 0-job baseline), or the prior score/jobs/slashes carried over with `bondHbar` updated to this call's real bond, on a re-registration. See `register()`'s doc comment. */
  reputation: Reputation;
};

/**
 * Progress ticks `register()` reports through `AssayNodeConfig.onRegisterProgress`,
 * one per phase boundary (not per underlying network attempt — those are the
 * adapters' own `onConfirmAttempt`/`onReputationWriteAttempt`). `elapsedMs`
 * is measured from the start of this `register()` call.
 */
export type RegisterProgress =
  | { phase: 'posting-bond'; elapsedMs: number }
  | { phase: 'publishing-manifest'; elapsedMs: number; bondRef: string; bondTxId: string }
  | { phase: 'initializing-reputation'; elapsedMs: number; bondRef: string; manifestTxHash: string }
  | { phase: 'done'; elapsedMs: number; result: RegisterResult };

/**
 * Progress ticks `settle()` reports through `AssayNodeConfig.onSettleProgress`
 * (issue #53). `elapsedMs` is measured from the start of this `settle()`
 * call. On an invalid verdict, `'slashing'` and `'writing-reputation'` are
 * both emitted immediately (elapsedMs ~0): the two legs start together, that
 * is the whole point of #53. On a valid verdict there is no slash, so only
 * the `'writing-reputation'`/`'reputation-*'` ticks fire.
 */
export type SettleProgress =
  | { phase: 'slashing'; elapsedMs: number }
  | { phase: 'writing-reputation'; elapsedMs: number }
  | { phase: 'slash-confirmed'; elapsedMs: number; txId: string }
  | { phase: 'slash-failed'; elapsedMs: number }
  | { phase: 'reputation-confirmed'; elapsedMs: number; txHash: string; reputation: Reputation }
  | { phase: 'reputation-failed'; elapsedMs: number }
  | { phase: 'done'; elapsedMs: number; job: Job };

export type ServeInput = {
  provider: string;
  capabilityId: string;
  request: unknown;
  /** The payment transaction this call must be confirmed by before anything runs. */
  txId: string;
};

export type PayAndCallResult = {
  txId: string;
  job: Job;
};

export interface AssayNode {
  /**
   * Provider registration end to end (SPEC.md §7 step 1): posts the bond,
   * publishes the manifest, and initializes reputation. Three real network
   * calls, strictly sequential, never parallel:
   *
   *   1. `payments.postBond(bondHbar)` — a real Hedera transfer (~4s settle).
   *   2. `registry.publishManifest(name, { ...manifest, bondRef })` — a real
   *      ENS text-record write (~12.5s).
   *   3. `registry.updateReputation(name, { bondHbar })` — another real ENS
   *      write (~12.5s), which either initializes `assay:rep` from zero (a
   *      name registered for the first time) or merges onto whatever
   *      reputation the name already had (see `RegisterResult.reputation`).
   *
   * **Ordering is forced, not a style choice.** The manifest's `bondRef` must
   * be the *real* reference the bond transaction returned (SPEC.md §5:
   * `assay:manifest`'s `bondRef` is not a placeholder a caller invents), so
   * the bond has to land before the manifest is written — there is no way to
   * publish a manifest with a real `bondRef` before the bond that produces it
   * exists. The consequence: a caller cannot retry `register()` itself after
   * a partial failure without risking a *second* real bond (see below).
   *
   * **Not atomic across networks** (SPEC.md §9: orchestration is explicitly
   * off-chain here, and this function is honest about that rather than
   * pretending otherwise):
   *
   *   - If `postBond` fails, nothing else has happened: no manifest, no
   *     reputation write. Safe to retry `register()` from scratch.
   *   - If `postBond` succeeds but `publishManifest` then fails, the
   *     provider is **bonded but unlisted** — real HBAR is committed with
   *     nowhere on ENS pointing at it yet. Rejects with
   *     `ManifestPublishFailedError`, which carries the real `bondRef`/
   *     `bondTxId`/`manifest` so the caller can retry the manifest publish
   *     directly instead of calling `register()` again (which would post a
   *     second, redundant bond).
   *   - If `postBond` and `publishManifest` both succeed but
   *     `updateReputation` then fails, the provider is **listed but not yet
   *     discoverable**: `discover()`/`payAndCall()` both call
   *     `registry.resolveProvider()`, which requires `assay:rep` to exist
   *     and throws otherwise. Rejects with `ReputationInitFailedError`,
   *     which carries enough state (`bondRef`, `bondTxId`, `manifestTxHash`)
   *     to retry just the reputation write directly.
   *
   * **Re-registering an already-registered name** is allowed and posts a
   * fresh bond, republishes the manifest (overwriting the old one, including
   * its `bondRef`), and re-runs `updateReputation({ bondHbar })` — which
   * *merges* onto the existing reputation, so `score`/`jobs`/`slashes`
   * survive a re-registration (a provider's history is not erased just
   * because it re-registered); only `bondHbar` is guaranteed to change, to
   * reflect the bond this call actually posted.
   *
   * Progress is reported through `AssayNodeConfig.onRegisterProgress` at each
   * phase boundary (see `RegisterProgress`): this is the slowest step in the
   * whole loop (~4s + ~12.5s + ~12.5s back to back), so the dashboard needs
   * something to narrate while it runs.
   */
  register(input: RegisterInput): Promise<RegisterResult>;
  /** Resolves `name` on the registry: manifest + reputation, for a requester to reason over before paying. */
  discover(name: string): Promise<ProviderRecord>;
  /**
   * `discover(name)` plus the structured risk read over it (issue #21): the
   * material an agent (via the MCP `discover` tool, #46) or a human reasons
   * over to decide whether the price is worth the reputation, without this
   * function collapsing that judgment into a verdict itself. See
   * `assessment.ts`.
   */
  assess(name: string): Promise<ProviderAssessment>;
  /**
   * Pays `capabilityId`'s price on `name`, then serves it. Two ways this can
   * refuse to pay: `evaluatePayDecision` (this node's `payPolicy`) declines
   * `name`'s assessment before any payment is attempted, rejecting with
   * `PayDeclinedError` and never calling `payments.pay()`; or the payment is
   * attempted but never confirms, rejecting with `PaymentNotConfirmedError`
   * from `serve()` below. Either way, no job is ever created.
   */
  payAndCall(name: string, capabilityId: string, request: unknown): Promise<PayAndCallResult>;
  /**
   * The payment gate (SPEC.md §12), and the only way a `Job` reaches
   * `served`. Structurally impossible to bypass: this function checks the
   * payment itself, unconditionally, before touching the capability runtime
   * or the job store — regardless of what the caller already believes about
   * the payment, and regardless of whether it was reached via `payAndCall`
   * or called directly. When `payments` implements `confirmPayment`, "checks
   * the payment" means the confirmed transaction actually paid at least
   * `manifest.priceHbar` to the provider's own account with a memo bound to
   * this exact `capabilityId`/`request` (see `PaymentNotConfirmedError`'s doc
   * comment); with only bare `confirm()`, it means the transaction merely
   * finalized as SUCCESS. Either way, a `txId` already spent on a prior job
   * is rejected by the job store (`DuplicatePaymentTxError`), so no
   * confirmed payment can fund two jobs.
   */
  serve(input: ServeInput): Promise<Job>;
  /** The job store backing this node. `challenge()`/`settle()` move jobs past `served` through it. */
  readonly jobs: JobStore;
  /**
   * Disputes one claim of a served job (SPEC.md §7 step 6). Routes to the
   * job's capability's `verify()` through the capability runtime with the
   * job's *full* claim set (a `Capability`'s `verify` re-derives and compares
   * all of them, not just one — see `runtime.ts`), moves the job
   * `served -> challenged` and records the verdict, and returns it.
   *
   * Throws `JobNotChallengeableError` if the job is not currently `served`
   * (this is what makes challenging the same claim twice fail cleanly rather
   * than silently re-running the verifier), and `UnknownClaimError` if
   * `claimKey` names no claim the job actually carries. Whatever the
   * capability's own `verify()` throws (e.g. its Graph read failing)
   * propagates as-is and leaves the job untouched at `served`, so a flaky
   * verify is safely retryable.
   */
  challenge(jobId: string, claimKey: string): Promise<Verdict>;
  /**
   * Settles an already-challenged job on `verdict` (SPEC.md §7 step 7, §9).
   *
   * - **Invalid** (the provider lied): slashes the provider's bond to
   *   `config.challengerAccountId` on Hedera (a real transaction) and drops
   *   the provider's ENS reputation (`computeSlashReputationDelta`) **at the
   *   same time** (issue #53) — the two are independent networks and neither
   *   result feeds the other, so running them one after another only added a
   *   silent ~12.5s wait after the money had already moved. See the
   *   implementation's own doc comment for the measured numbers and exactly
   *   how each outcome combination is handled.
   * - **Valid** (the challenge failed): moves the job to `settled`, then
   *   raises the provider's ENS reputation (`computeChallengeFailedReputationDelta`).
   *   There is only one real network leg on this path (no slash), so nothing
   *   here runs concurrently with it. See `settlement-policy.ts` for why this
   *   does not also move a challenger deposit: no deposit is ever taken
   *   anywhere in this build.
   *
   * **The property this protects, unchanged since before #53's concurrency:**
   * the job's `status` always truthfully reflects whether the money-moving
   * side (the slash, or simply "no slash needed" on a valid verdict) actually
   * happened, regardless of what the ENS reputation write did. Concretely:
   *
   *  - Slash succeeds (or there is no slash to attempt): the job moves out of
   *    `challenged` for real — to `slashed` or `settled` — before the ENS
   *    write's own outcome is inspected. If that write then fails, `settle()`
   *    rejects with `ReputationUpdateFailedError`, but the job's
   *    `status`/`verdict` are already correct and durable; only the
   *    reputation side needs a retry.
   *  - Slash fails (invalid-verdict path only): the job is left exactly as it
   *    was, still `challenged` — a retry is always safe. `settle()` rejects
   *    with `SlashFailedError`, which also names what the *concurrent* ENS
   *    write did (it can still have succeeded, since it was never gated on
   *    the slash — see that error's doc comment for why that is disclosed
   *    rather than hidden, and what it means for a subsequent retry).
   *
   * Throws `JobNotSettleableError` if the job is not currently `challenged`
   * (this is what makes a double-settle safe: the second call never reaches
   * `payments.slash()` again — payment idempotence, not just a store-status
   * check), and `MissingChallengerAccountError` on an invalid verdict if no
   * `challengerAccountId` was configured (checked before either network call
   * is attempted). Progress is reported through
   * `AssayNodeConfig.onSettleProgress` (see `SettleProgress`).
   */
  settle(jobId: string, verdict: Verdict): Promise<Job>;
}

/**
 * Binds a payment to the request it pays for: `payAndCall` writes this into
 * the payment's memo (via `payments.pay(amountHbar, requestHash)`), and
 * `serve()` below recomputes the same hash from `input.capabilityId`/
 * `input.request` and checks it against the memo `payments.confirmPayment`
 * reads back off the mirror node, so a confirmed payment can only unlock the
 * exact call it was made for (hedera-F1: this binding used to be written but
 * never read back, so it bound nothing at runtime). Deterministic and
 * dependency-free: `node:crypto` is a Node builtin, not a new package
 * dependency.
 */
export function hashRequest(capabilityId: string, request: unknown): string {
  return createHash('sha256').update(JSON.stringify({ capabilityId, request })).digest('hex');
}

export function createAssayNode(config: AssayNodeConfig): AssayNode {
  const { registry, payments, capabilities } = config;
  const jobs = config.jobs ?? createJobStore();
  const payPolicy = config.payPolicy ?? DEFAULT_PAY_DECISION_POLICY;
  const settlementPolicy = config.settlementPolicy ?? DEFAULT_SETTLEMENT_POLICY;

  // Concurrency guard for `settle()`, not for correctness of a single
  // sequential caller (the job-store's own `served`/`challenged` transitions
  // already make a *sequential* double-challenge or double-settle fail, see
  // `JobNotChallengeableError`/`JobNotSettleableError`). This exists for the
  // narrower case of two `settle()` calls in flight at once on the same
  // job before either has reached its first `transition()`: without it both
  // could pass the `status === 'challenged'` check and both call
  // `payments.slash()`. Real money moves here, so this is cheap insurance,
  // not a claim that the whole node is safe under arbitrary concurrency —
  // SPEC.md §9 already discloses the orchestration is off-chain and not
  // atomic across networks.
  const settlingJobIds = new Set<string>();

  async function serve(input: ServeInput): Promise<Job> {
    // Prefer the strict gate when the port supports it: it checks the
    // confirmed transaction actually paid this capability's real price, to
    // the provider's own configured account, with a memo bound to this exact
    // request (hedera-F1). A port that only implements bare `confirm()`
    // falls back to the pre-existing, weaker SUCCESS-only check — see
    // `PaymentNotConfirmedError`'s doc comment for why that gap is disclosed,
    // not hidden.
    if (payments.confirmPayment) {
      const provider = await registry.resolveProvider(input.provider);
      const expectedMemo = hashRequest(input.capabilityId, input.request);
      const confirmation = await payments.confirmPayment({
        txId: input.txId,
        expectedAmountHbar: provider.manifest.priceHbar,
        expectedMemo,
      });
      if (!confirmation.confirmed) {
        throw new PaymentNotConfirmedError(input.txId);
      }
    } else {
      const confirmed = await payments.confirm(input.txId);
      if (!confirmed) {
        throw new PaymentNotConfirmedError(input.txId);
      }
    }

    const { result, claims } = await capabilities.run(input.capabilityId, input.request);
    // `jobs.create` itself rejects a `txId` already spent on a prior job
    // (`DuplicatePaymentTxError`), closing the replay path regardless of
    // which confirmation branch above ran.
    return jobs.create({
      provider: input.provider,
      capabilityId: input.capabilityId,
      request: input.request,
      paymentTx: input.txId,
      result,
      claims,
    });
  }

  async function challenge(jobId: string, claimKey: string): Promise<Verdict> {
    const job = jobs.get(jobId);
    if (job.status !== 'served') {
      throw new JobNotChallengeableError(jobId, job.status);
    }
    if (!job.claims.some((claim) => claim.k === claimKey)) {
      throw new UnknownClaimError(
        jobId,
        claimKey,
        job.claims.map((claim) => claim.k),
      );
    }

    // The `Capability.verify` contract (types.ts, SPEC.md §6) re-derives and
    // compares the *whole* claim set, not just `claimKey` in isolation:
    // `claimKey` names which claim the challenger is disputing (and is
    // validated above), but the verifier itself decides validity over
    // everything the job claimed.
    const verdict = await capabilities.verify(job.capabilityId, job.request, job.result, job.claims);

    jobs.transition(jobId, 'challenged', { verdict });
    return verdict;
  }

  async function settle(jobId: string, verdict: Verdict): Promise<Job> {
    const job = jobs.get(jobId);
    if (job.status !== 'challenged') {
      throw new JobNotSettleableError(jobId, job.status);
    }
    if (settlingJobIds.has(jobId)) {
      throw new SettlementInProgressError(jobId);
    }

    settlingJobIds.add(jobId);
    const start = Date.now();
    const elapsed = () => Date.now() - start;
    const onProgress = config.onSettleProgress;

    try {
      if (!verdict.valid) {
        if (!config.challengerAccountId) {
          throw new MissingChallengerAccountError(jobId);
        }

        const provider = await registry.resolveProvider(job.provider);
        const reputationDelta = computeSlashReputationDelta(provider.reputation, settlementPolicy);

        // The Hedera slash and the ENS reputation write target two
        // independent networks, and neither's outcome is an input to the
        // other: `reputationDelta` above is computed entirely from
        // `provider.reputation`, already read, not from anything
        // `payments.slash()` returns. Measured live (#53): the slash settles
        // in ~4.1s, the ENS write in ~12.5s (three samples: 24.6s, 12.59s,
        // 12.39s -- the 24.6s looks like a cold-write outlier, not the
        // baseline). Running them one after another put ~17s after the
        // verdict, landing on the demo's closing beat in silence. Firing
        // both at once cuts that tail to ~12.5s, the slower of the two, not
        // their sum.
        //
        // The one thing this trades away: before #53, if `payments.slash()`
        // threw, the ENS write was never even attempted, so "the slash
        // failed" and "ENS was not touched" were the same fact. Now they can
        // come apart -- the write can still land even though the slash did
        // not, because both were already in flight. `SlashFailedError`
        // below is what names that outcome so it is never ambiguous which
        // of the two actually happened.
        onProgress?.({ phase: 'slashing', elapsedMs: elapsed() });
        onProgress?.({ phase: 'writing-reputation', elapsedMs: elapsed() });

        // Both calls are made here, immediately, one right after the other
        // with no `await` between them -- that is what actually starts them
        // concurrently; a `Promise.allSettled([a(), b()])` one-liner would
        // do the same thing, but it would also swallow *when* each one
        // individually finishes (it only resolves once both have). Each
        // promise gets its own `.then`/`.catch` below purely to report its
        // own `-confirmed`/`-failed` tick the moment *it* settles (e.g. the
        // slash landing at ~4.1s while the ENS write is still mining at
        // ~12.5s, exactly like the dashboard's slash fixture narrates) --
        // attaching a second handler here does not delay or re-trigger the
        // underlying call.
        const slashPromise = payments.slash(provider.manifest.bondRef, config.challengerAccountId);
        const reputationPromise = registry.updateReputation(job.provider, reputationDelta);

        slashPromise.then(
          (result) => onProgress?.({ phase: 'slash-confirmed', elapsedMs: elapsed(), txId: result.txId }),
          () => onProgress?.({ phase: 'slash-failed', elapsedMs: elapsed() }),
        );
        reputationPromise.then(
          (result) =>
            onProgress?.({
              phase: 'reputation-confirmed',
              elapsedMs: elapsed(),
              txHash: result.txHash,
              reputation: result.reputation,
            }),
          () => onProgress?.({ phase: 'reputation-failed', elapsedMs: elapsed() }),
        );

        const [slashOutcome, reputationOutcome] = await Promise.allSettled([slashPromise, reputationPromise]);

        if (slashOutcome.status === 'rejected') {
          const reputationWrite: ConcurrentReputationOutcome =
            reputationOutcome.status === 'fulfilled'
              ? {
                  outcome: 'succeeded',
                  txHash: reputationOutcome.value.txHash,
                  reputation: reputationOutcome.value.reputation,
                }
              : { outcome: 'failed', cause: reputationOutcome.reason };
          // Money never moved: the job is left exactly as it was, still
          // `"challenged"`, whatever the concurrent ENS write did (see
          // `SlashFailedError`'s doc comment on why that write's own outcome
          // still matters even though the job itself does not change here).
          throw new SlashFailedError(jobId, job.provider, slashOutcome.reason, reputationWrite);
        }

        // The real, money-moving side effect happened for real: record it
        // regardless of what the concurrent ENS write did, same honesty
        // `ReputationUpdateFailedError` has always protected (SPEC.md §9's
        // "not atomic across networks").
        const slashed = jobs.transition(jobId, 'slashed', { verdict });
        onProgress?.({ phase: 'done', elapsedMs: elapsed(), job: slashed });

        if (reputationOutcome.status === 'rejected') {
          throw new ReputationUpdateFailedError(jobId, slashed, reputationOutcome.reason);
        }

        return slashed;
      }

      // Valid verdict: the challenge failed, the provider is vindicated. No
      // money moves (see settlement-policy.ts's doc comment on why a
      // challenger deposit is not forfeited here) -- there is only the one
      // real network leg here, so there is nothing to run concurrently with
      // it. Same "record the real state before the slow ENS write" ordering
      // as the slash path, for the same honesty reason.
      const provider = await registry.resolveProvider(job.provider);
      const settled = jobs.transition(jobId, 'settled', { verdict });

      onProgress?.({ phase: 'writing-reputation', elapsedMs: elapsed() });
      try {
        const { txHash, reputation } = await registry.updateReputation(
          job.provider,
          computeChallengeFailedReputationDelta(provider.reputation, settlementPolicy),
        );
        onProgress?.({ phase: 'reputation-confirmed', elapsedMs: elapsed(), txHash, reputation });
      } catch (cause) {
        onProgress?.({ phase: 'reputation-failed', elapsedMs: elapsed() });
        onProgress?.({ phase: 'done', elapsedMs: elapsed(), job: settled });
        throw new ReputationUpdateFailedError(jobId, settled, cause);
      }

      onProgress?.({ phase: 'done', elapsedMs: elapsed(), job: settled });
      return settled;
    } finally {
      settlingJobIds.delete(jobId);
    }
  }

  return {
    async register({ name, manifest, bondHbar }) {
      const start = Date.now();
      const onProgress = config.onRegisterProgress;
      const elapsed = () => Date.now() - start;

      // 1. Bond first: SPEC.md §5's `assay:manifest.bondRef` must be the real
      // reference this transaction returns, so nothing can be published
      // before it exists.
      onProgress?.({ phase: 'posting-bond', elapsedMs: elapsed() });
      const { bondRef, txId: bondTxId } = await payments.postBond(bondHbar);

      const fullManifest: Manifest = { ...manifest, bondRef };

      // 2. Manifest, now carrying the real bondRef. If this fails, the bond
      // already happened for real -- surface that as ManifestPublishFailedError
      // rather than letting the caller believe a retry of register() is free.
      onProgress?.({ phase: 'publishing-manifest', elapsedMs: elapsed(), bondRef, bondTxId });
      let manifestTxHash: string;
      try {
        ({ txHash: manifestTxHash } = await registry.publishManifest(name, fullManifest));
      } catch (cause) {
        throw new ManifestPublishFailedError(name, bondRef, bondTxId, fullManifest, cause);
      }

      // 3. Reputation init, last: without this write `resolveProvider()`
      // (and therefore discover()/payAndCall()) cannot resolve `name` at
      // all (MissingRecordError on `assay:rep`). `{ bondHbar }` is the whole
      // delta -- on a first-ever registration `updateReputation` merges it
      // onto the zero reputation every RegistryPort implementation already
      // treats an unset assay:rep as (matching assessment.ts's "unproven"
      // 0-job baseline); on a re-registration it merges onto whatever
      // score/jobs/slashes the name already carries, so history survives.
      onProgress?.({ phase: 'initializing-reputation', elapsedMs: elapsed(), bondRef, manifestTxHash });
      let reputationTxHash: string;
      let reputation: Reputation;
      try {
        ({ txHash: reputationTxHash, reputation } = await registry.updateReputation(name, { bondHbar }));
      } catch (cause) {
        throw new ReputationInitFailedError(name, manifestTxHash, bondRef, bondTxId, cause);
      }

      const result: RegisterResult = { bondRef, bondTxId, manifestTxHash, reputationTxHash, reputation };
      onProgress?.({ phase: 'done', elapsedMs: elapsed(), result });
      return result;
    },

    async discover(name) {
      return registry.resolveProvider(name);
    },

    async assess(name) {
      const provider = await registry.resolveProvider(name);
      return assessProvider(provider);
    },

    async payAndCall(name, capabilityId, request) {
      const provider = await registry.resolveProvider(name);
      const assessment = assessProvider(provider);
      const decision = evaluatePayDecision(assessment, payPolicy);
      if (!decision.pay) {
        throw new PayDeclinedError(name, assessment, decision.reason, decision.violations);
      }
      const requestHash = hashRequest(capabilityId, request);
      const { txId } = await payments.pay(provider.manifest.priceHbar, requestHash);
      const job = await serve({ provider: name, capabilityId, request, txId });
      return { txId, job };
    },

    serve,

    jobs,

    challenge,

    settle,
  };
}

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
import type { Job, JobStatus, Manifest, ProviderRecord, Verdict } from './types.js';

/**
 * Thrown by `serve()` when `payments.confirm(txId)` does not return `true`.
 * This is the only reason a `Job` fails to be created after a payment was
 * attempted: SPEC.md §12 forbids serving on an unconfirmed or failed
 * payment, and `serve()` checks `confirm()` itself, unconditionally, before
 * running the capability or touching the job store.
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
};

export type RegisterInput = {
  name: string;
  manifest: Manifest;
  bondHbar: number;
};

export type RegisterResult = {
  manifestTxHash: string;
  bondRef: string;
  bondTxId: string;
};

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
   * Publishes the manifest and posts the bond (SPEC.md §7 step 1). Reputation
   * initialization is deliberately out of scope here: the real registry's
   * `updateReputation` is an explicit stub (#16), not a working write yet, so
   * calling it from `register()` would make this function fail against the
   * live adapter today. That wiring belongs to whoever closes #16/#17.
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
   * `served`. Structurally impossible to bypass: this function checks
   * `payments.confirm(txId)` itself, unconditionally, before touching the
   * capability runtime or the job store — regardless of what the caller
   * already believes about the payment, and regardless of whether it was
   * reached via `payAndCall` or called directly.
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
   *   `config.challengerAccountId` on Hedera (a real transaction), moves the
   *   job to `slashed`, then drops the provider's ENS reputation
   *   (`computeSlashReputationDelta`).
   * - **Valid** (the challenge failed): moves the job to `settled`, then
   *   raises the provider's ENS reputation (`computeChallengeFailedReputationDelta`).
   *   See `settlement-policy.ts` for why this does not also move a
   *   challenger deposit: no deposit is ever taken anywhere in this build.
   *
   * Ordering is deliberate and disclosed, not atomic (SPEC.md §9): the job
   * moves out of `challenged` (recording the real, already-happened
   * on-chain effect — the slash, or simply "no slash needed") *before* the
   * ENS write is attempted. If that write then fails, `settle()` rejects
   * with `ReputationUpdateFailedError`, but the job's `status`/`verdict` in
   * the store are already correct and truthful; only the reputation side
   * still needs a retry. Throws `JobNotSettleableError` if the job is not
   * currently `challenged` (this is what makes a double-settle safe: the
   * second call never reaches `payments.slash()` again), and
   * `MissingChallengerAccountError` on an invalid verdict if no
   * `challengerAccountId` was configured.
   */
  settle(jobId: string, verdict: Verdict): Promise<Job>;
}

/**
 * Binds a payment to the request it pays for, so a payment cannot be replayed
 * against a different call. Deterministic and dependency-free: `node:crypto`
 * is a Node builtin, not a new package dependency.
 */
function hashRequest(capabilityId: string, request: unknown): string {
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
    const confirmed = await payments.confirm(input.txId);
    if (!confirmed) {
      throw new PaymentNotConfirmedError(input.txId);
    }
    const { result, claims } = await capabilities.run(input.capabilityId, input.request);
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
    try {
      if (!verdict.valid) {
        if (!config.challengerAccountId) {
          throw new MissingChallengerAccountError(jobId);
        }

        const provider = await registry.resolveProvider(job.provider);
        // The real, money-moving side effect: a Hedera transfer, not a
        // simulated one. If this throws, nothing below runs and the job
        // stays `challenged`, so a retry (once whatever failed is fixed) is
        // safe.
        await payments.slash(provider.manifest.bondRef, config.challengerAccountId);

        // Recorded *before* the ENS write is attempted: the slash already
        // happened for real, so the job must say so even if the reputation
        // write below fails (SPEC.md §9's "not atomic across networks",
        // made honest here rather than papered over).
        const slashed = jobs.transition(jobId, 'slashed', { verdict });

        try {
          await registry.updateReputation(
            job.provider,
            computeSlashReputationDelta(provider.reputation, settlementPolicy),
          );
        } catch (cause) {
          throw new ReputationUpdateFailedError(jobId, slashed, cause);
        }

        return slashed;
      }

      // Valid verdict: the challenge failed, the provider is vindicated. No
      // money moves (see settlement-policy.ts's doc comment on why a
      // challenger deposit is not forfeited here); only the reputation goes
      // up. Same "record the real state before the slow ENS write" ordering
      // as the slash path, for the same honesty reason.
      const provider = await registry.resolveProvider(job.provider);
      const settled = jobs.transition(jobId, 'settled', { verdict });

      try {
        await registry.updateReputation(
          job.provider,
          computeChallengeFailedReputationDelta(provider.reputation, settlementPolicy),
        );
      } catch (cause) {
        throw new ReputationUpdateFailedError(jobId, settled, cause);
      }

      return settled;
    } finally {
      settlingJobIds.delete(jobId);
    }
  }

  return {
    async register({ name, manifest, bondHbar }) {
      const { txHash: manifestTxHash } = await registry.publishManifest(name, manifest);
      const { bondRef, txId: bondTxId } = await payments.postBond(bondHbar);
      return { manifestTxHash, bondRef, bondTxId };
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

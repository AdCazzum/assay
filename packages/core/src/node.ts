/**
 * `createAssayNode` — the loop from SPEC.md §7, wired over the three port
 * seams (`RegistryPort`, `PaymentsPort`, `GraphPort`) and the capability
 * runtime. This is the rail: it orchestrates adapters and never touches a
 * concrete network client, and it knows nothing about rug-score (that
 * knowledge lives entirely inside whatever `Capability` the caller
 * registers).
 *
 * `challenge()`/`settle()` belong to #26/#27. This file leaves them as
 * explicitly-named extension points that throw a descriptive error, the same
 * pattern `@assay/registry`'s `updateReputation` already uses for its own
 * not-yet-built piece (#16): a stub that says what it is, rather than a
 * half-implementation that looks done and isn't.
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
import type { CapabilityRegistry } from './runtime.js';
import type { Job, Manifest, ProviderRecord, Verdict } from './types.js';

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

export type AssayNodeConfig = {
  registry: RegistryPort;
  payments: PaymentsPort;
  /**
   * Threaded through for the `challenge()`/`settle()` extension points
   * (#26/#27), which will need to re-derive claims from The Graph at each
   * claim's `atBlock`. The loop implemented here (register / discover /
   * payAndCall / serve) never calls it directly: a capability's own
   * `run`/`verify` already close over their `GraphPort` at construction time
   * (see `@assay/cap-rugscore`'s `createRugScoreCapability`).
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
  /** The job store backing this node. `challenge()`/`settle()` implementations use it to move jobs past `served`. */
  readonly jobs: JobStore;
  /** Extension point for #26: not implemented here. Always rejects. */
  challenge(jobId: string, claimKey: string): Promise<Verdict>;
  /** Extension point for #27: not implemented here. Always rejects. */
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

  async function serve(input: ServeInput): Promise<Job> {
    const confirmed = await payments.confirm(input.txId);
    if (!confirmed) {
      throw new PaymentNotConfirmedError(input.txId);
    }
    const { result, claims } = await capabilities.run(input.capabilityId, input.request);
    return jobs.create({
      provider: input.provider,
      request: input.request,
      paymentTx: input.txId,
      result,
      claims,
    });
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

    async challenge(jobId, claimKey) {
      throw new Error(
        `challenge(jobId, claimKey) is tracked in #26; called with job="${jobId}" claim="${claimKey}".`,
      );
    },

    async settle(jobId, verdict) {
      throw new Error(
        `settle(jobId, verdict) is tracked in #27; called with job="${jobId}" verdict=${JSON.stringify(verdict)}.`,
      );
    },
  };
}

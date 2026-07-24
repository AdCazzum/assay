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
import { createJobStore, type JobStore } from './job-store.js';
import type { GraphPort, PaymentsPort, RegistryPort } from './ports.js';
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
   * Pays `capabilityId`'s price on `name`, then serves it. Never resolves to
   * a job unless the payment actually confirms: an unconfirmed or failed
   * payment rejects with `PaymentNotConfirmedError` from `serve()` below, and
   * no job is ever created.
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

    async payAndCall(name, capabilityId, request) {
      const provider = await registry.resolveProvider(name);
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

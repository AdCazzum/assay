/**
 * Shared data model for the Assay rail. See SPEC.md §5 and §6.
 *
 * These types are the contract every adapter and capability is written against,
 * so the packages can be built independently.
 */

/**
 * A factual assertion a result carries with it, stamped to the block it was
 * derived at. `atBlock` is mandatory: it is what makes verification
 * deterministic, and what stops data drift from slashing honest providers.
 */
export type Claim = {
  k: string;
  v: unknown;
  atBlock: number;
};

/** The verdict a verifier returns for a set of claims. */
export type Verdict = {
  valid: boolean;
  /** The `k` of the first claim that failed, when `valid` is false. */
  badClaim?: string;
  /** Human-readable reason, for the dashboard narration. */
  reason?: string;
};

/**
 * A service a provider offers. The protocol knows nothing about the semantics
 * of what a capability computes: it only knows how to run it and how to verify
 * what it claimed.
 */
export interface Capability<Req = unknown, Res = unknown> {
  id: string;
  run(req: Req): Promise<{ result: Res; claims: Claim[] }>;
  verify(req: Req, result: Res, claims: Claim[]): Promise<Verdict>;
}

/** Capability manifest, published as the ENS text record `assay:manifest`. */
export type Manifest = {
  capabilityId: string;
  description: string;
  priceHbar: number;
  endpoint: string;
  bondRef: string;
  verifierHash: string;
};

/** Provider reputation, published as the ENS text record `assay:rep`. */
export type Reputation = {
  score: number;
  jobs: number;
  slashes: number;
  bondHbar: number;
};

/** What `resolveProvider` returns: a provider's public state, read from ENS. */
export type ProviderRecord = {
  name: string;
  manifest: Manifest;
  reputation: Reputation;
};

export type JobStatus = 'served' | 'challenged' | 'slashed' | 'settled';

/** Off-chain job state held by the Assay node. */
export type Job = {
  jobId: string;
  provider: string;
  /**
   * The capability registry id this job ran (e.g. `"rugscore"`). Stored on
   * the job, not just passed to `serve()`, because `challenge()` (#26) needs
   * it later to route back through the same capability's `verify()` without
   * the core having to guess or re-resolve it from the manifest.
   */
  capabilityId: string;
  request: unknown;
  paymentTx: string;
  result: unknown;
  claims: Claim[];
  status: JobStatus;
  verdict?: Verdict;
};

/**
 * The narrow seam this MCP server depends on. See SPEC.md §4, §7.
 *
 * `packages/core`'s `createAssayNode` (issues #20, #21) is being built by a
 * sibling agent at the same time as this one and does not exist in this
 * worktree yet. Rather than wait or reimplement the loop here, this file
 * defines the slice of the node's behavior the four MCP tools actually need.
 * Wiring the real thing in later is meant to be a one-line change to
 * `index.ts`'s `main()`: nothing in `server.ts` or the tool handlers should
 * need to change, because they only ever see `AssayNodePort`.
 */

import type {
  Claim,
  Job,
  Manifest,
  ProviderAssessment,
  ProviderRecord,
  RegisterProgress,
  RegisterResult,
  Verdict,
} from '@assay/core';

/**
 * What `discover` resolves with: the raw provider record (manifest +
 * reputation, straight off ENS) *and* the structured risk read over it
 * (issue #21's `assessProvider`, issue #46). SPEC.md §16 names "agentic must
 * be real reasoning, not a hardcoded if" as a headline risk, so this
 * deliberately hands back `assessment.signals` (each with a severity and a
 * human-readable `detail`) rather than collapsing the read into a verdict:
 * the calling agent is the one who decides whether the price is justified.
 */
export type DiscoverResult = {
  provider: ProviderRecord;
  assessment: ProviderAssessment;
};

/**
 * What `verifyClaim` resolves with (issue #84). Deliberately carries the
 * job's *full* claim set, not just the one named `claimKey`: the point of
 * this tool is to give a model the material to reach "this is false, I am
 * challenging it" on its own evidence, and that means showing what was
 * claimed (`claims`, each already carrying its own `atBlock`) side by side
 * with the verdict the same claim re-derived from The Graph produced.
 * Nothing here hardcodes a signal name -- `claims` is whatever the capability
 * that served this job actually claimed, and `verdict.reason` is whatever
 * that capability's own `verify()` wrote (SPEC.md §6, §12), so this stays
 * correct for any capability, not just rug-score.
 */
export type VerifyClaimResult = {
  jobId: string;
  claimKey: string;
  claims: Claim[];
  verdict: Verdict;
};

/** One candidate resolved by `listProviders` (issue #84): either a real hit or a clearly-labelled miss, never a thrown error that would kill the whole call. */
export type ProviderListItem =
  | { name: string; outcome: 'ok'; provider: ProviderRecord; assessment: ProviderAssessment }
  | { name: string; outcome: 'miss'; reason: string };

/** `registerProvider`'s result: `register()`'s own `RegisterResult` plus the full ENS name the label resolved to. */
export type RegisterProviderResult = RegisterResult & { name: string };

/**
 * The requester-side operations an MCP client drives. Maps 1:1 to the nine
 * tools (`discover`, `pay_and_call`, `challenge`, `rate`, `verify_claim`,
 * `register_provider`, `list_providers`, `get_job`, `list_jobs`); see SPEC.md
 * §7 for the loop each one is a step of.
 */
export interface AssayNodePort {
  /**
   * Resolves a provider for `capabilityId` (the ENS name registered under
   * the Assay parent name, e.g. `"rugscore.assay.eth"`) and returns its
   * manifest, reputation, and a structured assessment of both. Read-only:
   * never pays, never calls the provider.
   */
  discover(capabilityId: string): Promise<DiscoverResult>;

  /**
   * Pays the provider's `priceHbar` on Hedera testnet with `request` bound
   * into the payment, confirms the transaction via the mirror node, then has
   * the provider run the capability. Resolves with the served job: the
   * result plus its block-stamped claims, `status: "served"`, optimistically
   * valid until challenged.
   *
   * By default this is gated by the node's pay/decline policy floor (issue
   * #21) and rejects with `PayDeclinedError` (from `@assay/core`) without
   * paying anything if the assessment trips it. Pass `force: true` to pay
   * anyway, once the calling agent has read the decline's reasoning and
   * judged it worth overriding; this still spends real testnet HBAR and
   * still runs the capability for real, it just skips that one floor.
   */
  payAndCall(capabilityId: string, request: unknown, force?: boolean): Promise<Job>;

  /**
   * Challenges one claim of an already-served job. The verifier re-derives
   * that claim from The Graph at the exact block it was stamped at. If it
   * does not match, the job settles `"slashed"` (the provider's bond is
   * slashed on Hedera and its ENS reputation drops); if it matches, the job
   * settles `"settled"` in the provider's favor.
   */
  challenge(jobId: string, claimKey: string): Promise<Job>;

  /**
   * Closes out an already-served job the caller is NOT challenging: records
   * whether the job was satisfactory. This never touches the verifier and
   * never slashes anything, it only accounts for a completed job (raising
   * the provider's `jobs` count, and its `score` when satisfied). Use
   * `challenge`, not this, when a specific claim looks objectively false.
   */
  rate(jobId: string, satisfied: boolean, comment?: string): Promise<Job>;

  /**
   * Re-derives one claim of an already-served job from The Graph, at that
   * claim's own `atBlock`, and reports the verdict -- without moving the job
   * or spending its one `served -> challenged` transition (issue #84). This
   * is `challenge`'s read-only sibling: same real re-derivation, same cost,
   * but nothing here commits to a dispute. Use this first to decide whether
   * a claim is actually false; call `challenge` only once you have.
   *
   * Unlike `challenge`, does not require the job to be `served`: a job
   * already challenged, slashed, or settled can still be re-verified.
   */
  verifyClaim(jobId: string, claimKey: string): Promise<VerifyClaimResult>;

  /**
   * Registers a brand-new provider under the Assay parent name (issue #84):
   * posts a real bond, publishes the manifest, and initializes reputation,
   * in that order, through `@assay/core`'s `register()` (never reimplemented
   * here). `label` is a bare subname label (e.g. `"myagent"`, no dots): the
   * full ENS name is built as `"<label>.<parent>"`, where `<parent>` is this
   * node's configured Assay parent name.
   *
   * Real, multi-network, and slow (a bond plus two ENS writes, ~25s
   * measured): `onProgress`, if given, is invoked once per phase boundary
   * (posting the bond, publishing the manifest, initializing reputation,
   * done) so a caller can narrate it rather than block in silence.
   */
  registerProvider(
    label: string,
    manifest: Omit<Manifest, 'bondRef'>,
    bondHbar: number,
    onProgress?: (progress: RegisterProgress) => void,
  ): Promise<RegisterProviderResult>;

  /**
   * Resolves every candidate provider name this node is configured with
   * (issue #84): ENS cannot be enumerated, so "discovery" here means
   * resolving a known set, not searching one. Each candidate comes back as
   * either an `'ok'` hit (provider + assessment, exactly `discover`'s
   * result) or a clearly-labelled `'miss'` (name does not resolve, or has no
   * manifest) -- one candidate failing never fails the whole call.
   */
  listProviders(): Promise<ProviderListItem[]>;

  /**
   * Reads one job by id off this node's job store (issue #84): status,
   * claims (each with its own `atBlock`), the funding payment, and any
   * verdict. Read-only, no network call. Throws `UnknownJobError` if
   * `jobId` was never created.
   */
  getJob(jobId: string): Promise<Job>;

  /** Every job this node's store has ever created, in creation order (issue #84). Read-only, no network call. */
  listJobs(): Promise<Job[]>;
}

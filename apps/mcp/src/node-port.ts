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

import type { Job, ProviderRecord } from '@assay/core';

/**
 * The requester-side operations an MCP client drives. Maps 1:1 to the four
 * tools (`discover`, `pay_and_call`, `challenge`, `rate`); see SPEC.md §7 for
 * the loop each one is a step of.
 */
export interface AssayNodePort {
  /**
   * Resolves a provider for `capabilityId` (e.g. `"rugscore"`) over ENS and
   * returns its manifest (price, endpoint, bond) and its on-chain reputation
   * (score, completed jobs, slashes). Read-only: never pays, never calls the
   * provider.
   */
  discover(capabilityId: string): Promise<ProviderRecord>;

  /**
   * Pays the provider's `priceHbar` on Hedera testnet with `request` bound
   * into the payment, confirms the transaction via the mirror node, then has
   * the provider run the capability. Resolves with the served job: the
   * result plus its block-stamped claims, `status: "served"`, optimistically
   * valid until challenged.
   */
  payAndCall(capabilityId: string, request: unknown): Promise<Job>;

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
}

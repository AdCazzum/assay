/**
 * Produces the one thing `challengeAndSettle` (`watchdog.ts`) needs to act on:
 * a served `Job`. There is no persistent, cross-process job store to read
 * one from (SPEC.md §17 rules that out), so a standalone watchdog run has to
 * serve its own job, in-process, before it can challenge it — exactly like
 * `apps/provider`'s demo mode and `apps/mcp`'s live wiring each build their
 * own `AssayNode` rather than reaching into another process's.
 */

import { createHash } from 'node:crypto';
import type { AssayNode, Job, Manifest, PaymentsPort, RegistryPort } from '@assay/core';

export type ServeForChallengeDeps = {
  node: AssayNode;
  registry: RegistryPort;
  payments: PaymentsPort;
};

export type ServeForChallengeResult = {
  jobId: string;
  job: Job;
  providerName: string;
  bondRef: string;
  bondTxId: string;
  manifestTxHash: string;
  payTxId: string;
};

/** Binds a payment to the request it pays for. Same construction `@assay/core`'s `node.ts` uses internally (its own copy is not exported). */
function hashRequest(capabilityId: string, request: unknown): string {
  return createHash('sha256').update(JSON.stringify({ capabilityId, request })).digest('hex');
}

/**
 * Re-bonds `providerName` with a fresh deposit, then pays and serves
 * `request` against it, all in this process.
 *
 * **Why not `AssayNode.register()` + `AssayNode.payAndCall()`:**
 *
 * - `register()` (`packages/core/src/node.ts`) posts a bond and returns its
 *   `bondRef`, but does not write that `bondRef` into the manifest it
 *   publishes — the manifest still carries whatever `bondRef` the caller put
 *   in it. `@assay/payments`'s Hedera adapter keeps its bond ledger
 *   in-memory, per process (`packages/payments/src/payments.ts`): `slash()`
 *   only recognizes a `bondRef` that *this same process's* `postBond()` call
 *   minted. So a manifest whose `bondRef` doesn't match what this process
 *   just deposited would make the eventual `settle()` call fail with
 *   "unknown bondRef" on a real slash. This function posts the bond first
 *   and threads its `bondRef` into the manifest itself, so the two always
 *   agree. Flagged rather than patched in `@assay/core`, which is out of
 *   scope for this app.
 * - `payAndCall()` applies `DEFAULT_PAY_DECISION_POLICY` (`pay-policy.ts`)
 *   before paying. That policy is meant to protect a real requester, but it
 *   also means: after this app slashes `providerName` a few times in a row
 *   (expected -- it targets a sacrificial subname exactly so rehearsals land
 *   here, see `live-node.ts`'s `LiveWatchdogNode.providerName` doc comment),
 *   its live slash ratio can legitimately trip `maxSlashRatio` and block a
 *   later demo run against that same name. That is the policy working as
 *   intended, not a bug — but it would make this app unable to demo itself
 *   twice. This function pays and
 *   serves directly, the same deliberate bypass `apps/mcp/src/live-node.ts`'s
 *   `force: true` path takes and for the same reason. The one gate that is
 *   never bypassed either way is `serve()`'s own `payments.confirm(txId)`
 *   check (SPEC.md §12): this function still goes through `node.serve()`,
 *   not around it.
 */
export async function serveForChallenge(
  deps: ServeForChallengeDeps,
  providerName: string,
  request: unknown,
  bondHbar: number,
): Promise<ServeForChallengeResult> {
  const { node, registry, payments } = deps;

  const current = await registry.resolveProvider(providerName);

  const { bondRef, txId: bondTxId } = await payments.postBond(bondHbar);
  const manifest: Manifest = { ...current.manifest, bondRef };
  const { txHash: manifestTxHash } = await registry.publishManifest(providerName, manifest);

  const requestHash = hashRequest(manifest.capabilityId, request);
  const { txId: payTxId } = await payments.pay(manifest.priceHbar, requestHash);
  const job = await node.serve({
    provider: providerName,
    capabilityId: manifest.capabilityId,
    request,
    txId: payTxId,
  });

  return { jobId: job.jobId, job, providerName, bondRef, bondTxId, manifestTxHash, payTxId };
}

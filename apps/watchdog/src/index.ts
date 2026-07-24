#!/usr/bin/env tsx
/**
 * @assay/watchdog — the actor that challenges a claim and triggers the
 * verifier (issue #28, SPEC.md §7 steps 6-8, §10 40-80s). This is the demo
 * climax, so this CLI is built to be watched: it serves one rug-score job
 * (honest, or the declared lying-provider harness), challenges the claim,
 * and settles on whatever the verifier decides, narrating every step with
 * real, independently-checkable artifacts.
 *
 * The watchdog does not know in advance which outcome it will get — see
 * `watchdog.ts`'s doc comment. `mode` below only picks which capability
 * *serves* the job (this app is standing in for both the provider and the
 * challenger role, since there is no second live process to hand a job to —
 * see `serve-for-challenge.ts`); `challengeAndSettle` itself always goes
 * through the real `AssayNode.challenge()`/`settle()` and reports whatever
 * verdict comes back.
 *
 * Usage:
 *   pnpm --filter @assay/watchdog exec tsx src/index.ts lying [token] [claimKey]
 *   pnpm --filter @assay/watchdog exec tsx src/index.ts honest [token] [claimKey]
 *
 * `token` defaults to a real, thin mainnet token (GOODCAT) that this repo has
 * already verified live scores as high-risk (see cap-rugscore's README);
 * `claimKey` defaults to `"liquidityUsd"`, the same claim
 * `createLyingRugScoreProvider` tampers by default.
 *
 * Requires the same `.env` as `apps/mcp` (AGENTS.md "Networks & secrets").
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { APP_ID, buildLiveWatchdogNode, type CapabilityMode } from './live-node.js';
import { serveForChallenge } from './serve-for-challenge.js';
import { challengeAndSettle, STAGED_DISCLOSURE } from './watchdog.js';

export { challengeAndSettle, STAGED_DISCLOSURE } from './watchdog.js';
export type { ChallengeAndSettleDeps, ChallengeAndSettleResult, Printer } from './watchdog.js';
export { observeSlash } from './slash-observer.js';
export type { ObservedPayments, SlashRecord } from './slash-observer.js';
export { buildLiveWatchdogNode, MissingConfigError, APP_ID } from './live-node.js';
export type { CapabilityMode, LiveWatchdogNode } from './live-node.js';
export { serveForChallenge } from './serve-for-challenge.js';
export type { ServeForChallengeDeps, ServeForChallengeResult } from './serve-for-challenge.js';

// Same convention every other package's live script uses (e.g.
// `packages/payments/scripts/spike.ts`, `apps/mcp/src/index.ts`). Never
// committed (AGENTS.md); a no-op if `.env` doesn't exist.
const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../..');
loadEnv({ path: path.join(repoRoot, '.env') });

/** GOODCAT: real mainnet token, verified live (SPEC.md's state notes) to score high-risk — thin liquidity, near-total pool concentration, a handful of swaps. */
const DEFAULT_TOKEN = '0xd6c68bc8c862722e140e7b339ddf8a144a7d3530';
const DEFAULT_CLAIM_KEY = 'liquidityUsd';
/** Comfortably above the pay policy's `minBondToPriceRatio` for any plausible `priceHbar` already published; see `serve-for-challenge.ts` on why the policy is bypassed for the pay itself but the bond is still real. */
const DEFAULT_BOND_HBAR = Number(process.env.WATCHDOG_BOND_HBAR ?? '20');

function parseArgs(argv: string[]): { mode: CapabilityMode; token: string; claimKey: string } {
  const [modeArg, tokenArg, claimKeyArg] = argv;
  if (modeArg !== undefined && modeArg !== 'honest' && modeArg !== 'lying') {
    console.error(`${APP_ID}: unknown mode "${modeArg}", expected "honest" or "lying". Defaulting to "lying".`);
  }
  const mode: CapabilityMode = modeArg === 'honest' ? 'honest' : 'lying';
  return { mode, token: tokenArg || DEFAULT_TOKEN, claimKey: claimKeyArg || DEFAULT_CLAIM_KEY };
}

async function main(): Promise<void> {
  const { mode, token, claimKey } = parseArgs(process.argv.slice(2));

  for (const line of STAGED_DISCLOSURE) console.log(line);
  console.log('');
  console.log(
    `${mode === 'lying' ? '[LYING PROVIDER, declared test harness]' : '[honest provider]'} ` +
      `rugScore.run(${token}), then challenging claim "${claimKey}"`,
  );
  console.log('');

  const { node, registry, payments, providerName, network, hashscanBaseUrl, getLastSlash } =
    buildLiveWatchdogNode(mode);

  console.log(`Serve      re-bonding and serving "${providerName}" on ${network}...`);
  const served = await serveForChallenge({ node, registry, payments }, providerName, token, DEFAULT_BOND_HBAR);
  console.log(`Serve      job "${served.jobId}" served. Pay tx: ${served.payTxId}`);
  console.log(`  bond: ${served.bondRef} (tx ${served.bondTxId})`);
  console.log(`  manifest tx: ${served.manifestTxHash}`);
  console.log(`  hashscan (pay): ${hashscanBaseUrl}/transaction/${served.payTxId}`);
  console.log('');

  const result = await challengeAndSettle(served.jobId, claimKey, {
    node,
    print: (line) => console.log(line),
    getLastSlash,
    hashscanBaseUrl,
  });

  console.log('');
  console.log(
    result.verdict.valid
      ? 'Outcome: challenge FAILED — the claim held up, the provider is vindicated, reputation rose.'
      : 'Outcome: challenge UPHELD — the provider lied, its bond was slashed, reputation dropped.',
  );
}

const isMain = process.argv[1] ? import.meta.url === `file://${process.argv[1]}` : false;
if (isMain) {
  main()
    .then(() => {
      // The Hedera SDK client (`@hashgraph/sdk`'s `Client`, held inside
      // `createHederaSdkTransferClient`) keeps its gRPC channels open for
      // reuse, same as every other live script in this repo
      // (`packages/payments/scripts/spike.ts`, `bond-slash.ts`) — nothing
      // here exposes a handle to close it, so an explicit exit is what
      // ends the process instead of hanging on those open connections.
      process.exit(0);
    })
    .catch((err) => {
      console.error(`${APP_ID} failed:`, err);
      process.exit(1);
    });
}

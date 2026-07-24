#!/usr/bin/env tsx
/**
 * Live smoke test for verify(): the real end-to-end round trip against the
 * real `@assay/graph` adapter (the live gateway, mainnet), not `FakeGraphPort`.
 *
 * Needs GRAPH_API_KEY in the repo root `.env` (see `.env.example`).
 *
 * Usage:
 *   pnpm --filter @assay/cap-rugscore exec tsx scripts/verify-smoke.ts
 */
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createGraphAdapter } from '@assay/graph';
import { createLyingRugScoreProvider, createRugScoreCapability } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, '..', '..', '..', '.env') });

// USDC (blue chip) and GOODCAT (the real, live-verified thin/sketchy token
// from packages/graph/README.md: one pool, txCount=2, ~$56 top-pool TVL).
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const GOODCAT = '0xd6c68bc8c862722e140e7b339ddf8a144a7d3530';

async function main() {
  const apiKey = process.env.GRAPH_API_KEY;
  if (!apiKey) {
    console.error('GRAPH_API_KEY is not set. Add it to the repo root .env (see .env.example) and re-run.');
    process.exit(1);
    return;
  }

  const graph = createGraphAdapter({ apiKey });
  const honest = createRugScoreCapability({ graph });

  console.log('--- 1. Honest round trip: USDC (blue chip) ---');
  const usdcRun = await honest.run(USDC);
  console.log(JSON.stringify(usdcRun, null, 2));
  const usdcVerdict = await honest.verify(USDC, usdcRun.result, usdcRun.claims);
  console.log('verdict:', JSON.stringify(usdcVerdict));
  if (!usdcVerdict.valid) throw new Error('expected USDC to verify clean');

  console.log('\n--- 2. Honest round trip: GOODCAT (real thin/sketchy token) ---');
  const goodcatRun = await honest.run(GOODCAT);
  console.log(JSON.stringify(goodcatRun, null, 2));
  const goodcatVerdict = await honest.verify(GOODCAT, goodcatRun.result, goodcatRun.claims);
  console.log('verdict:', JSON.stringify(goodcatVerdict));
  if (!goodcatVerdict.valid) throw new Error('expected GOODCAT to verify clean (it is honestly thin, not lied about)');

  console.log('\n--- 3. The lying provider (declared test harness) tampers GOODCAT liquidityUsd ---');
  const lying = createLyingRugScoreProvider({ graph });
  const lyingRun = await lying.run(GOODCAT);
  console.log(JSON.stringify(lyingRun, null, 2));
  const lyingVerdict = await honest.verify(GOODCAT, lyingRun.result, lyingRun.claims);
  console.log('verdict:', JSON.stringify(lyingVerdict));
  if (lyingVerdict.valid || lyingVerdict.badClaim !== 'liquidityUsd') {
    throw new Error(`expected the lying provider to be caught on liquidityUsd, got ${JSON.stringify(lyingVerdict)}`);
  }

  console.log('\n--- 4. Not slashed when the chain moves: verify GOODCAT at its served block while the head has advanced ---');
  const currentHead = await graph.getLatestBlock();
  console.log(`served at block ${goodcatRun.claims[0]?.atBlock}, current head is now ${currentHead}`);
  const staleVerdict = await honest.verify(GOODCAT, goodcatRun.result, goodcatRun.claims);
  console.log('verdict (re-verified after time has passed):', JSON.stringify(staleVerdict));
  if (!staleVerdict.valid) throw new Error('an honest, unchanged claim must still verify after the head advances');

  console.log('\nPASS: all live verify() checks behaved as expected.');
}

main().catch((err) => {
  console.error('[verify-smoke] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

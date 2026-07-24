#!/usr/bin/env tsx
/**
 * Live smoke test for @assay/graph. Not a unit test (no fake fetch): this
 * hits the real Token API over the network with a real key and prints real
 * mainnet signals for USDC, a clean, well-known control token.
 *
 * Run with:
 *   pnpm --filter @assay/graph exec tsx scripts/smoke.ts
 *
 * Requires GRAPH_API_KEY in the repo root `.env` (see .env.example).
 */

import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createGraphAdapter } from '../src/adapter.js';
import { GraphApiError, GraphRateLimitError } from '../src/errors.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, '..', '..', '..', '.env') });

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

async function main() {
  const apiKey = process.env.GRAPH_API_KEY;
  if (!apiKey) {
    console.error(
      'GRAPH_API_KEY is not set. Add it to the repo root .env (see .env.example) and re-run.\n' +
        'This script makes real, billed calls against The Graph Token API — nothing is mocked.',
    );
    process.exitCode = 1;
    return;
  }

  const graph = createGraphAdapter({ apiKey });

  console.log('Fetching latest block (via reference-token proxy, see README.md)...');
  const latestBlock = await graph.getLatestBlock();
  console.log(`  latest block ~= ${latestBlock}`);

  console.log(`\nFetching token signals for USDC (${USDC}) at the live block...`);
  const signals = await graph.getTokenSignals(USDC);
  console.log(JSON.stringify(signals, null, 2));

  console.log(`\nFetching the same token signals again, pinned to atBlock=${latestBlock}...`);
  const pinned = await graph.getTokenSignals(USDC, latestBlock);
  console.log(JSON.stringify(pinned, null, 2));
}

main().catch((error: unknown) => {
  if (error instanceof GraphRateLimitError) {
    console.error(`Rate limited by the Token API (retry after ${error.retryAfterSeconds ?? 'unknown'}s).`);
  } else if (error instanceof GraphApiError) {
    console.error(`Token API error (status ${error.status}):`, error.message, error.body);
  } else {
    console.error('Unexpected error:', error);
  }
  process.exitCode = 1;
});

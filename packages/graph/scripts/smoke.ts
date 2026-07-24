#!/usr/bin/env tsx
/**
 * Live smoke test for @assay/graph. Not a unit test (no fake fetch): this
 * hits the real gateway over the network with a real key and prints real
 * mainnet signals for USDC, a clean, well-known control token, at two
 * different historical blocks — this is the block-pinning proof the issue
 * asks for: two different `atBlock`s must yield genuinely different values.
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
import { GraphApiError, GraphBlockOutOfRangeError, GraphRateLimitError } from '../src/errors.js';
import { UNISWAP_V3_MAINNET_START_BLOCK } from '../src/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, '..', '..', '..', '.env') });

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

async function main() {
  const apiKey = process.env.GRAPH_API_KEY;
  if (!apiKey) {
    console.error(
      'GRAPH_API_KEY is not set. Add it to the repo root .env (see .env.example) and re-run.\n' +
        'This script makes real, billed calls against The Graph gateway — nothing is mocked.',
    );
    process.exitCode = 1;
    return;
  }

  const graph = createGraphAdapter({ apiKey });

  console.log("Fetching this subgraph's own indexed head (_meta.block.number)...");
  const latestBlock = await graph.getLatestBlock();
  console.log(`  latest queryable block = ${latestBlock}`);

  const older = 20_000_000;
  const newer = 22_000_000;
  console.log(`\nFetching USDC (${USDC}) signals pinned to atBlock=${older}...`);
  const atOlder = await graph.getTokenSignals(USDC, older);
  console.log(JSON.stringify(atOlder, null, 2));

  console.log(`\nFetching the same token signals again, pinned to atBlock=${newer}...`);
  const atNewer = await graph.getTokenSignals(USDC, newer);
  console.log(JSON.stringify(atNewer, null, 2));

  console.log('\n--- Block-pinning proof ---');
  console.log(`liquidityUsd at ${older}: ${atOlder.liquidityUsd}`);
  console.log(`liquidityUsd at ${newer}: ${atNewer.liquidityUsd}`);
  console.log(
    atOlder.liquidityUsd !== atNewer.liquidityUsd
      ? 'PASS: the two pinned blocks returned genuinely different values.'
      : 'FAIL: values did not differ — block-pinning is not actually working.',
  );

  console.log(`\nFetching the current head signals (atBlock omitted)...`);
  const live = await graph.getTokenSignals(USDC);
  console.log(JSON.stringify(live, null, 2));

  console.log(`\nConfirming a block before the manifest startBlock (${UNISWAP_V3_MAINNET_START_BLOCK}) fails loudly...`);
  try {
    await graph.getTokenSignals(USDC, 1000);
    console.log('FAIL: expected GraphBlockOutOfRangeError, got a result instead.');
  } catch (error) {
    if (error instanceof GraphBlockOutOfRangeError) {
      console.log(`PASS: threw GraphBlockOutOfRangeError(reason="${error.reason}"): ${error.message}`);
    } else {
      throw error;
    }
  }
}

main().catch((error: unknown) => {
  if (error instanceof GraphRateLimitError) {
    console.error(`Rate limited by the gateway (retry after ${error.retryAfterSeconds ?? 'unknown'}s).`);
  } else if (error instanceof GraphBlockOutOfRangeError) {
    console.error(`Block out of range (${error.reason}): ${error.message}`);
  } else if (error instanceof GraphApiError) {
    console.error(`Gateway error (status ${error.status}):`, error.message, error.body);
  } else {
    console.error('Unexpected error:', error);
  }
  process.exitCode = 1;
});

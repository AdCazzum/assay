#!/usr/bin/env tsx
/**
 * Live smoke test for @assay/graph. Not a unit test (no fake fetch): this
 * hits the real gateway over the network with a real key and prints real
 * mainnet signals for USDC, a clean, well-known control token, at two
 * different historical blocks — this is the block-pinning proof the issue
 * asks for: two different `atBlock`s must yield genuinely different values.
 *
 * It also queries two real, thin/sketchy tokens (see README.md "the
 * thin/sketchy contrast, live and real") at the current head, for the
 * contrast a lying-provider demo trades on: a provider claiming deep
 * liquidity is caught the moment the same query, at the same block, comes
 * back with a number the audience can read off screen.
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
import { GraphApiError, GraphBlockOutOfRangeError, GraphRateLimitError, GraphTokenNotFoundError } from '../src/errors.js';
import { UNISWAP_V3_MAINNET_START_BLOCK } from '../src/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, '..', '..', '..', '.env') });

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
// Real mainnet contracts, verified live on 2026-07-25 (see README.md): both
// genuinely thin, not test fixtures. Their exact numbers will keep moving
// (or the pools may age out of "thin") as the chain advances after that date.
const THIN_TOKENS = [
  { symbol: 'GOODCAT', address: '0xd6c68bc8c862722e140e7b339ddf8a144a7d3530' },
  { symbol: 'yRise', address: '0x6051c1354ccc51b4d561e43b02735deae64768b8' },
];

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
  console.log(`liquidityUsd  at ${older}: ${atOlder.liquidityUsd}`);
  console.log(`liquidityUsd  at ${newer}: ${atNewer.liquidityUsd}`);
  console.log(`txCount       at ${older}: ${atOlder.txCount}`);
  console.log(`txCount       at ${newer}: ${atNewer.txCount}`);
  console.log(`volumeUsd     at ${older}: ${atOlder.volumeUsd}`);
  console.log(`volumeUsd     at ${newer}: ${atNewer.volumeUsd}`);
  const genuinelyDifferent =
    atOlder.liquidityUsd !== atNewer.liquidityUsd &&
    atOlder.txCount !== atNewer.txCount &&
    atOlder.volumeUsd !== atNewer.volumeUsd;
  console.log(
    genuinelyDifferent
      ? 'PASS: the two pinned blocks returned genuinely different values for every real field.'
      : 'FAIL: at least one field did not differ — block-pinning is not actually working.',
  );

  console.log(`\nFetching the current head signals for USDC (atBlock omitted)...`);
  const live = await graph.getTokenSignals(USDC);
  console.log(JSON.stringify(live, null, 2));

  console.log('\n--- The thin/sketchy contrast (this is what the lying-provider demo sells) ---');
  for (const { symbol, address } of THIN_TOKENS) {
    try {
      const signals = await graph.getTokenSignals(address);
      console.log(`\n${symbol} (${address}) @ block ${signals.atBlock}:`);
      console.log(JSON.stringify(signals, null, 2));
    } catch (error) {
      if (error instanceof GraphTokenNotFoundError) {
        console.log(`\n${symbol} (${address}): no longer resolves to a Token entity (${error.message}).`);
      } else {
        throw error;
      }
    }
  }

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

#!/usr/bin/env tsx
/**
 * Live smoke test for rug-score's run(): the round trip that fires the
 * moment credentials and the real Graph adapter both land.
 *
 * Needs two things this repo does not have yet, so this script is not
 * runnable today, on purpose:
 *
 *  1. GRAPH_API_KEY in a local `.env` (see `.env.example` at the repo root).
 *  2. @assay/graph's real adapter (tracked in its own issue, built in
 *     parallel). This package only depends on the `GraphPort` interface from
 *     @assay/core, so it never imported @assay/graph's internals or waited
 *     on it (see AGENTS.md) — which also means this script can't hardcode a
 *     factory that does not exist yet. It looks up `createGraphPort` on
 *     @assay/graph at runtime and fails with a clear message if that export
 *     isn't there, instead of breaking `pnpm -r typecheck` for the rest of
 *     the workspace by importing a name that may not match what lands.
 *
 * Once both are in place:
 *   pnpm --filter @assay/cap-rugscore smoke 0x<tokenAddress>
 */
import 'dotenv/config';
import type { GraphPort } from '@assay/core';
import { createRugScoreCapability } from '../src/index.js';

async function loadRealGraphPort(): Promise<GraphPort> {
  const apiKey = process.env.GRAPH_API_KEY;
  if (!apiKey) {
    throw new Error('GRAPH_API_KEY is not set. Copy .env.example to .env and fill it in.');
  }

  const mod: Record<string, unknown> = await import('@assay/graph');
  const factory = mod.createGraphPort;
  if (typeof factory !== 'function') {
    throw new Error(
      '@assay/graph does not export createGraphPort yet (it is built in a sibling issue). ' +
        'This script will start working the moment that adapter lands.',
    );
  }
  return (factory as (config: { apiKey: string }) => GraphPort)({ apiKey });
}

async function main() {
  const token = process.argv[2];
  if (!token) {
    console.error('Usage: pnpm --filter @assay/cap-rugscore smoke <tokenAddress>');
    process.exit(1);
    return;
  }

  const graph = await loadRealGraphPort();
  const capability = createRugScoreCapability({ graph });

  const { result, claims } = await capability.run(token);
  console.log(JSON.stringify({ token, result, claims }, null, 2));
}

main().catch((err) => {
  console.error('[smoke] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

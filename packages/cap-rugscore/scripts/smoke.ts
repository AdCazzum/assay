#!/usr/bin/env tsx
/**
 * Live smoke test for rug-score's run(): the real end-to-end round trip
 * (a real `@assay/graph` adapter, hitting the real gateway) rather than the
 * `FakeGraphPort` unit tests use.
 *
 * Needs GRAPH_API_KEY in the repo root `.env` (see `.env.example`).
 *
 * Usage:
 *   pnpm --filter @assay/cap-rugscore smoke 0x<tokenAddress>
 */
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createGraphAdapter } from '@assay/graph';
import { createRugScoreCapability } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, '..', '..', '..', '.env') });

async function main() {
  const token = process.argv[2];
  if (!token) {
    console.error('Usage: pnpm --filter @assay/cap-rugscore smoke <tokenAddress>');
    process.exit(1);
    return;
  }

  const apiKey = process.env.GRAPH_API_KEY;
  if (!apiKey) {
    console.error('GRAPH_API_KEY is not set. Add it to the repo root .env (see .env.example) and re-run.');
    process.exit(1);
    return;
  }

  const graph = createGraphAdapter({ apiKey });
  const capability = createRugScoreCapability({ graph });

  const { result, claims } = await capability.run(token);
  console.log(JSON.stringify({ token, result, claims }, null, 2));
}

main().catch((err) => {
  console.error('[smoke] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

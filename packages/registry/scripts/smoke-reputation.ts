#!/usr/bin/env tsx
/**
 * Live smoke test for `updateReputation` (issue #16). Real Sepolia RPC
 * calls, no fakes. Run with:
 *
 *   pnpm --filter @assay/registry exec tsx scripts/smoke-reputation.ts
 *
 * Reads SEPOLIA_RPC_URL, SEPOLIA_PRIVATE_KEY, ENS_PARENT_NAME from `.env`
 * at the repo root (see `.env.example`). Against `<label>.${ENS_PARENT_NAME}`
 * (label defaults to "rugscore", override with SMOKE_LABEL — same default as
 * `smoke.ts`, so this targets the same name that already holds a manifest):
 *
 *   1. writes a first reputation record (initializing `assay:rep`, or
 *      overwriting whatever is there — this script does not assume which),
 *   2. reads it back,
 *   3. applies a second delta computed off that read-back value (the same
 *      "read current, pass the new absolute value" pattern `apps/mcp`'s
 *      `live-node.ts` `rate()` uses against the real port),
 *   4. reads it back again,
 *
 * printing the write-progress ticks (`onReputationWriteAttempt`) and the
 * elapsed time of each write. SPEC.md/#53 flags ENS write latency (24.6s
 * measured for `publishManifest`) as a live demo risk; this is what gives
 * `updateReputation` its own measured numbers rather than assuming they
 * match.
 *
 * PREREQUISITE: same as `smoke.ts` — `<label>.${ENS_PARENT_NAME}` must
 * already exist with a resolver set, or this fails fast with
 * NoResolverConfiguredError.
 */

import { config as loadEnv } from 'dotenv';
import type { Reputation } from '@assay/core';
import { createEnsRegistry, type ReputationWriteProgress } from '../src/ens-registry.js';
import { EnsRegistryError } from '../src/errors.js';

loadEnv();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `missing ${key}. Set it in a .env file at the repo root (see .env.example) before running the smoke script.`,
    );
  }
  return value;
}

function logProgress(label: string): (info: ReputationWriteProgress) => void {
  return (info) => {
    if (info.phase === 'writing') {
      console.log(`[smoke:rep] ${label}: writing (${info.writeState}) at ${info.elapsedMs}ms`);
    } else if (info.phase === 'reading') {
      console.log(`[smoke:rep] ${label}: reading current record...`);
    } else {
      console.log(`[smoke:rep] ${label}: done in ${info.elapsedMs}ms (tx ${info.txHash})`);
    }
  };
}

async function main() {
  const rpcUrl = requireEnv('SEPOLIA_RPC_URL');
  const privateKey = requireEnv('SEPOLIA_PRIVATE_KEY');
  const parentName = requireEnv('ENS_PARENT_NAME');
  const label = process.env.SMOKE_LABEL ?? 'rugscore';
  const name = `${label}.${parentName}`;

  console.log(`[smoke:rep] target name: ${name}`);
  console.log(`[smoke:rep] rpc: ${rpcUrl}`);

  const elapsedByWrite: number[] = [];

  const registry = createEnsRegistry({
    rpcUrl,
    privateKey,
    parentName,
    onReputationWriteAttempt: (info) => {
      logProgress(`write #${elapsedByWrite.length + 1}`)(info);
    },
  });

  // --- Write #1: whatever assay:rep currently holds (or ZERO_REPUTATION if
  // unset) gets `score`/`bondHbar` overwritten, jobs/slashes carried over. ---
  console.log('[smoke:rep] write #1: updateReputation(name, { score: 80, bondHbar: 50 })...');
  const write1Started = Date.now();
  const first = await registry.updateReputation(name, { score: 80, bondHbar: 50 });
  const write1ElapsedMs = Date.now() - write1Started;
  elapsedByWrite.push(write1ElapsedMs);

  console.log(`[smoke:rep] write #1 confirmed in ${write1ElapsedMs}ms`);
  console.log(`[smoke:rep] tx: https://sepolia.etherscan.io/tx/${first.txHash}`);
  console.log('[smoke:rep] reputation after write #1:', JSON.stringify(first.reputation, null, 2));

  // --- Read back independently, through resolveProvider-adjacent path: the
  // registry's own return value already is the read-back value (it's what
  // got encoded and sent), but re-resolving proves the round trip through
  // Sepolia rather than trusting the local return value alone. This needs
  // `assay:manifest` to already exist on `name` (true for the default
  // "rugscore" label per issue #15's live proof); if it does not, this
  // script still reports both write timings, just skips this cross-check. ---
  let readBack: Reputation | undefined;
  try {
    const record = await registry.resolveProvider(name);
    readBack = record.reputation;
    console.log('[smoke:rep] resolveProvider read-back matches write #1:', JSON.stringify(readBack, null, 2));
  } catch (err) {
    console.log(
      `[smoke:rep] resolveProvider read-back skipped (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const current = readBack ?? first.reputation;

  // --- Write #2: a second delta computed off the read-back current value,
  // the same pattern apps/mcp's rate() uses: "one more job, score +1". ---
  console.log('[smoke:rep] write #2: updateReputation(name, { jobs: current.jobs + 1, score: current.score + 1 })...');
  const write2Started = Date.now();
  const second = await registry.updateReputation(name, {
    jobs: current.jobs + 1,
    score: Math.min(100, current.score + 1),
  });
  const write2ElapsedMs = Date.now() - write2Started;
  elapsedByWrite.push(write2ElapsedMs);

  console.log(`[smoke:rep] write #2 confirmed in ${write2ElapsedMs}ms`);
  console.log(`[smoke:rep] tx: https://sepolia.etherscan.io/tx/${second.txHash}`);
  console.log('[smoke:rep] reputation after write #2:', JSON.stringify(second.reputation, null, 2));

  const roundTripOk =
    second.reputation.jobs === current.jobs + 1 && second.reputation.score === Math.min(100, current.score + 1);
  console.log(`[smoke:rep] delta applied correctly: ${roundTripOk ? 'OK' : 'MISMATCH'}`);

  console.log('[smoke:rep] --- summary ---');
  console.log(`[smoke:rep] write #1 elapsed: ${write1ElapsedMs}ms`);
  console.log(`[smoke:rep] write #2 elapsed: ${write2ElapsedMs}ms`);

  if (!roundTripOk) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  if (err instanceof EnsRegistryError) {
    console.error(`[smoke:rep] ${err.name}: ${err.message}`);
  } else {
    console.error('[smoke:rep] failed:', err);
  }
  process.exitCode = 1;
});

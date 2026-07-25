#!/usr/bin/env tsx
/**
 * Regenerates `@assay/dashboard`'s two canonical fixtures
 * (`src/fixtures/happy-path.ts`, `src/fixtures/slash.ts`) from a real,
 * live-network recorded run (issue #85: "Regenerate the fixtures from a real
 * recorded run rather than hand-writing them again. A fixture captured from
 * the live stream cannot drift from what the live path emits, which is
 * exactly how the last set ended up narrating a claim the verifier could no
 * longer check (#54)").
 *
 * This reuses `apps/demo`'s own live wiring (`buildLiveDemoNodes`) and
 * `@assay/dashboard`'s own `createCoreEventMapper` — the identical mapping
 * the live demo (`main.ts`) drives through — so the fixtures this produces
 * are provably the same shape a live run emits, not a parallel hand-rolled
 * approximation of it.
 *
 * Usage (from the repo root, requires the full live `.env` per
 * AGENTS.md "Networks & secrets"; run `scripts/reset-demo-state.ts` first so
 * the good provider is in its opening state, exactly like a real demo
 * rehearsal would):
 *
 *   pnpm --filter @assay/demo exec tsx scripts/capture-fixtures.ts
 *
 * Real cost: one real Hedera payment against the good provider, one real
 * Hedera bond + payment + slash against the sacrificial provider, and three
 * real ENS writes (the sacrificial re-bond's manifest, plus the reputation
 * write `settle()` makes). Re-run `scripts/reset-demo-state.ts` afterwards
 * before rehearsing or demoing for real, the same as after any watchdog run.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { createCoreEventMapper } from '@assay/dashboard';
import type { LoopEvent } from '@assay/dashboard';
import type { Manifest } from '@assay/core';
import { buildLiveDemoNodes } from '../src/live-node.js';
import { formatReputationHeartbeat } from '../src/reputation-heartbeat.js';
import { DEFAULT_CHALLENGE_BOND_HBAR, DEFAULT_CLAIM_KEY, DEFAULT_LIAR_TOKEN, DEFAULT_REQUEST_TOKEN } from '../src/token-fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const DASHBOARD_FIXTURES_DIR = path.join(REPO_ROOT, 'apps', 'dashboard', 'src', 'fixtures');

loadEnv({ path: path.join(REPO_ROOT, '.env') });

function serializeEvents(events: readonly LoopEvent[]): string {
  const lines = events.map((event) => `  ${JSON.stringify(event, null, 2).split('\n').join('\n  ')},`);
  return `[\n${lines.join('\n')}\n]`;
}

function writeFixture(fileName: string, exportName: string, header: string, events: readonly LoopEvent[]): void {
  const target = path.join(DASHBOARD_FIXTURES_DIR, fileName);
  const body = `${header}\n\nimport type { LoopEvent } from '../events.js';\n\nexport const ${exportName}: readonly LoopEvent[] = ${serializeEvents(events)};\n`;
  writeFileSync(target, body);
  console.log(`[capture-fixtures] wrote ${target} (${events.length} events)`);
}

async function main(): Promise<void> {
  const requesterEvents: LoopEvent[] = [];
  const slashEvents: LoopEvent[] = [];
  const requesterMapper = createCoreEventMapper();
  const challengeMapper = createCoreEventMapper();

  const nodes = buildLiveDemoNodes({
    onRequesterEvent: (event) => {
      for (const mapped of requesterMapper(event)) requesterEvents.push(mapped);
    },
    // Unlike the live demo's own filtering (session.ts), the capture here is
    // unfiltered: @assay/dashboard's standalone SLASH_EVENTS fixture is its
    // own self-contained loop narrative (register/discover through
    // reputation, "tsx src/index.ts slash"), not sliced per demo key. The
    // live demo's `rehearsal.ts` does its own filtering when it replays this
    // same fixture for the "4 challenge" key.
    onChallengeEvent: (event) => {
      for (const mapped of challengeMapper(event)) slashEvents.push(mapped);
    },
    // Same heartbeat wiring as `main.ts` (see `live-node.ts`'s module doc
    // comment): without it the captured fixture would render the reputation
    // write as a single frozen `running` row instead of the real ~3s-cadence
    // heartbeat a live audience actually watches.
    onReputationHeartbeat: (info) => {
      const event = formatReputationHeartbeat(info);
      if (event) slashEvents.push(event);
    },
  });

  console.log(`[capture-fixtures] good provider: ${nodes.goodProviderName}`);
  console.log(`[capture-fixtures] sacrificial provider: ${nodes.liarProviderName}`);

  // --- Happy path: discover + pay + serve + accept against the good provider ---
  console.log('[capture-fixtures] capturing happy path...');
  await nodes.requesterNode.discover(nodes.goodProviderName);
  await nodes.requesterNode.payAndCall(nodes.goodProviderName, 'rugscore', DEFAULT_REQUEST_TOKEN);

  // --- Slash: re-bond the sacrificial provider (same idiom as
  // apps/watchdog/src/serve-for-challenge.ts and session.ts's doChallenge —
  // a fresh process's payments client only recognizes a bondRef it minted
  // itself), then discover/pay/serve/challenge/settle for real. ---
  console.log('[capture-fixtures] capturing the slash climax (re-bonding first)...');
  await nodes.challengeNode.discover(nodes.liarProviderName);
  const current = await nodes.registry.resolveProvider(nodes.liarProviderName);
  const { bondRef } = await nodes.payments.postBond(DEFAULT_CHALLENGE_BOND_HBAR);
  const manifest: Manifest = { ...current.manifest, bondRef };
  await nodes.registry.publishManifest(nodes.liarProviderName, manifest);

  const { job } = await nodes.challengeNode.payAndCall(nodes.liarProviderName, 'rugscore', DEFAULT_LIAR_TOKEN);
  const verdict = await nodes.challengeNode.challenge(job.jobId, DEFAULT_CLAIM_KEY);
  await nodes.challengeNode.settle(job.jobId, verdict);

  // SPEC.md §11: label the declared test harness honestly, directly in the
  // one line the audience actually reads on screen (the fixture's own doc
  // comment says this too, but that is not what a viewer of the rendered
  // dashboard sees).
  const serveEvent = slashEvents.find((e) => e.step === 'serve');
  if (serveEvent) {
    serveEvent.summary = `[LYING PROVIDER, declared test harness] ${serveEvent.summary}`;
  }

  const stamp = new Date().toISOString();
  writeFixture(
    'happy-path.ts',
    'HAPPY_PATH_EVENTS',
    `/**\n * The canonical happy-path event sequence: discover through accept, no\n * challenge, against the real good provider (\`${nodes.goodProviderName}\`).\n * Captured live from a real run on ${stamp} by \`apps/demo/scripts/capture-fixtures.ts\`\n * (issue #85) — every value below is a genuine Hedera/ENS/Graph artifact\n * from that run, mapped through the exact same \`@assay/dashboard\`\n * \`createCoreEventMapper\` the live demo drives, not hand-written.\n * Regenerate rather than hand-edit if this drifts.\n */`,
    requesterEvents,
  );
  writeFixture(
    'slash.ts',
    'SLASH_EVENTS',
    `/**\n * The lying-provider climax: discover through the ENS reputation write,\n * against the sacrificial provider (\`${nodes.liarProviderName}\`) running\n * \`@assay/cap-rugscore\`'s \`createLyingRugScoreProvider\` (SPEC.md §11: a\n * declared test harness, not a faked sponsor integration — the bond, the\n * payment, the verifier's re-derivation from The Graph, the slash and the\n * ENS write are all real). Captured live on ${stamp} by\n * \`apps/demo/scripts/capture-fixtures.ts\` (issue #85); every tx id, block\n * number and claim value below is genuine. Regenerate rather than hand-edit\n * if this drifts.\n */`,
    slashEvents,
  );

  nodes.close();
}

main().catch((err) => {
  console.error('[capture-fixtures] failed:', err);
  process.exit(1);
});

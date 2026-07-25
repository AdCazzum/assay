/**
 * @assay/demo — a real Claude agent driving the Assay MCP server, with its
 * reasoning and the loop's real chain state on one screen (issues #93/#94).
 * Replaces the keypress runner from #86 entirely: no keypresses drive the
 * loop here, the agent does, and this app only watches.
 *
 * Run this file directly to pick a mode:
 *
 *   pnpm --filter @assay/demo exec tsx src/index.ts live                     # a real agent, real networks
 *   pnpm --filter @assay/demo exec tsx src/index.ts rehearsal [capturePath]  # offline replay of a captured run
 *
 * `rehearsal` with no path picks the most recently captured
 * `apps/demo/captures/*.scenic.ndjson` file.
 */

export const APP_ID = '@assay/demo';

export { runScenicLive, runScenicRehearsal, findLatestCapture } from './scenic-runner.js';
export { buildLiveDemoNodes, MissingConfigError } from './live-node.js';
export type { LiveDemoNodes, BuildLiveDemoNodesOptions } from './live-node.js';
export { checkDemoReadiness } from './reset-check.js';
export type { ReadinessCheck } from './reset-check.js';
export { startKeyboard } from './keys.js';
export type { KeyboardHandle, KeyboardOptions } from './keys.js';
export { formatReputationHeartbeat } from './reputation-heartbeat.js';

import { runScenicLive, runScenicRehearsal, findLatestCapture } from './scenic-runner.js';

async function main(): Promise<void> {
  const [, , modeArg, capturePathArg] = process.argv;
  const mode = modeArg ?? 'live';

  if (mode === 'live') {
    const { exitCode } = await runScenicLive();
    process.exitCode = exitCode;
    return;
  }

  if (mode === 'rehearsal') {
    const capturePath = capturePathArg ?? findLatestCapture();
    if (!capturePath) {
      console.error(
        `${APP_ID}: no capture found. Pass a path (tsx src/index.ts rehearsal <path>.scenic.ndjson), ` +
          'or run "live" once first to record one under apps/demo/captures/.',
      );
      process.exitCode = 1;
      return;
    }
    await runScenicRehearsal(capturePath);
    return;
  }

  console.error(`${APP_ID}: unknown mode "${modeArg}". Usage: tsx src/index.ts live|rehearsal [capturePath]`);
  process.exitCode = 1;
}

const isMain = process.argv[1] ? import.meta.url === `file://${process.argv[1]}` : false;
if (isMain) {
  main().catch((err) => {
    console.error(`${APP_ID} failed:`, err);
    process.exit(1);
  });
}

/**
 * @assay/demo — drives the whole Assay demo from one keyboard (issue #86).
 *
 * Composes the real adapters (`live-node.ts`), `@assay/core`'s loop, the
 * rug-score capability, and `@assay/dashboard`'s renderer into one screen
 * (`screen.ts`) you step through on keypress (`step-machine.ts`/`session.ts`).
 * See `docs/demo-run-sheet.md` for the running order this implements, which
 * is measured rather than invented.
 *
 * Run this file directly to pick a mode:
 *
 *   pnpm --filter @assay/demo exec tsx src/index.ts live        # real networks
 *   pnpm --filter @assay/demo exec tsx src/index.ts rehearsal   # no network, paced fixture replay
 */

export const APP_ID = '@assay/demo';

export * from './legend.js';
export * from './step-machine.js';
export { createDemoSession } from './session.js';
export type { DemoSessionDeps } from './session.js';
export { createRehearsalSession } from './rehearsal.js';
export type { RehearsalSessionDeps } from './rehearsal.js';
export { Screen } from './screen.js';
export type { ScreenOptions, Writer } from './screen.js';
export { startKeyboard } from './keys.js';
export type { KeyboardHandle, KeyboardOptions } from './keys.js';
export { buildLiveDemoNodes, MissingConfigError } from './live-node.js';
export type { LiveDemoNodes, BuildLiveDemoNodesOptions } from './live-node.js';
export { checkDemoReadiness } from './reset-check.js';
export type { ReadinessCheck } from './reset-check.js';

const MODES = {
  live: () => import('./main.js').then((m) => m.main()),
  rehearsal: () => import('./rehearsal-main.js').then((m) => m.main()),
} as const;

async function main(): Promise<void> {
  const [, , modeArg] = process.argv;
  const mode = (modeArg ?? 'live') as keyof typeof MODES;
  const run = MODES[mode];
  if (!run) {
    console.error(`${APP_ID}: unknown mode "${modeArg}". Usage: tsx src/index.ts live|rehearsal`);
    process.exitCode = 1;
    return;
  }
  await run();
}

const isMain = process.argv[1] ? import.meta.url === `file://${process.argv[1]}` : false;
if (isMain) {
  main().catch((err) => {
    console.error(`${APP_ID} failed:`, err);
    process.exit(1);
  });
}

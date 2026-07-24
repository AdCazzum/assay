/**
 * @assay/dashboard — narrates the Assay loop on screen (issue #30, SPEC.md §10).
 *
 * Library surface:
 *  - `events.ts`   — `LoopEvent`/`LoopState` and the fold (`reduceEvents`).
 *  - `render.ts`   — pure `render(events)` / `renderState(state)`, ANSI only.
 *  - `sink.ts`     — the one impure part: `attach()` prints frames to a
 *                     writer as events arrive, `replay()` paces a fixture.
 *  - `fixtures/`   — the two canonical event sequences (happy path, slash),
 *                     for zero-network rehearsal (SPEC.md §14).
 *
 * Run this file directly to rehearse a fixture with no network at all:
 *   pnpm --filter @assay/dashboard exec tsx src/index.ts slash
 *   pnpm --filter @assay/dashboard exec tsx src/index.ts happy 300
 */

export * from './events.js';
export * from './render.js';
export * from './sink.js';
export { HAPPY_PATH_EVENTS } from './fixtures/happy-path.js';
export { SLASH_EVENTS } from './fixtures/slash.js';

import { attach, replay } from './sink.js';
import { HAPPY_PATH_EVENTS } from './fixtures/happy-path.js';
import { SLASH_EVENTS } from './fixtures/slash.js';

const FIXTURES = {
  happy: HAPPY_PATH_EVENTS,
  slash: SLASH_EVENTS,
} as const;

const DEFAULT_REHEARSAL_DELAY_MS = 900;

async function main(): Promise<void> {
  const [, , fixtureName = 'slash', delayArg] = process.argv;
  const fixture = FIXTURES[fixtureName as keyof typeof FIXTURES];
  if (!fixture) {
    console.error(
      `Unknown fixture "${fixtureName}". Known fixtures: ${Object.keys(FIXTURES).join(', ')}.`,
    );
    process.exitCode = 1;
    return;
  }
  const delayMs = delayArg !== undefined ? Number(delayArg) : DEFAULT_REHEARSAL_DELAY_MS;
  await attach(replay(fixture, delayMs));
}

// Only run the CLI rehearsal when this file is executed directly (tsx/node),
// never when imported as a library, e.g. from the test suite.
const isMain = typeof process !== 'undefined' && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

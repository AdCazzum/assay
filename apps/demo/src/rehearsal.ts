/**
 * The offline rehearsal (issue #86: "a rehearsal mode with no network,
 * replaying a captured run at the same pace"). Drives the exact same
 * `step-machine.ts` the live session (`session.ts`) uses — same four keys,
 * same guard-against-restart, same "advancing is explicit" rules — but each
 * step replays a slice of `@assay/dashboard`'s own captured fixtures
 * (`HAPPY_PATH_EVENTS`/`SLASH_EVENTS`, regenerated from a real run by
 * `scripts/capture-fixtures.ts`) instead of making a network call. This is
 * what makes "the live path and rehearsal path render identically" (issue
 * #85) true of the whole demo, not just of `render()`: both paths push the
 * identical `LoopEvent` shapes into the identical `Screen`, through the
 * identical keyboard machine, differing only in *where* the events come
 * from.
 *
 * The slice-by-step boundaries mirror `session.ts`'s own live sequencing
 * exactly: `discover`/`pay` map to the good provider's own steps in
 * `HAPPY_PATH_EVENTS`; `serve` also folds in `accept` (the live serve step
 * pushes both, back to back, with no keypress between them); `challenge`
 * replays only `SLASH_EVENTS`' `challenge`/`verify`/`slash`/`reputation`
 * entries, never its own discover/pay/serve/accept preamble — the same
 * "the sacrificial provider's own setup is silent" decision `session.ts`'s
 * `doChallenge` makes live, so a rehearsal audience sees exactly what a live
 * audience would.
 */

import { HAPPY_PATH_EVENTS, SLASH_EVENTS } from '@assay/dashboard';
import type { LoopEvent } from '@assay/dashboard';
import { createStepMachine, type DemoSession, type DemoStepId, type StepRunners } from './step-machine.js';

const CHALLENGE_VISIBLE_STEPS = new Set<LoopEvent['step']>(['challenge', 'verify', 'slash', 'reputation']);

const STEP_EVENTS: Readonly<Record<DemoStepId, readonly LoopEvent[]>> = {
  discover: HAPPY_PATH_EVENTS.filter((e) => e.step === 'discover'),
  pay: HAPPY_PATH_EVENTS.filter((e) => e.step === 'pay'),
  serve: HAPPY_PATH_EVENTS.filter((e) => e.step === 'serve' || e.step === 'accept'),
  challenge: SLASH_EVENTS.filter((e) => CHALLENGE_VISIBLE_STEPS.has(e.step)),
};

/**
 * Total wall-clock time each step's replay is spread over, matching
 * `docs/demo-run-sheet.md`'s measured numbers (discover/pay/serve are the
 * fast side of the "agent: discover, reason, pay, serve, 42-57s" figure —
 * this app's own discover/pay/serve are not agent reasoning, so they are
 * paced at their own real measured cost instead of the agent's; `challenge`
 * matches the run sheet's "watchdog: serve, challenge, verify, slash, ENS
 * write, 19-43s" figure directly, biased toward the top of that range so
 * the ENS write's own heartbeat cadence — one tick per fixture event —
 * reads as realistic).
 */
const STEP_TARGET_MS: Readonly<Record<DemoStepId, number>> = {
  discover: 600,
  pay: 4100,
  serve: 1500,
  challenge: 27000,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type RehearsalSessionDeps = {
  push(event: LoopEvent): void;
  onStatus?: (message: string) => void;
  /**
   * Overrides `STEP_TARGET_MS` (real demo pacing). Exists so this module's
   * own tests can replay the identical fixtures/guards at a fraction of the
   * real timing rather than skipping the pacing behavior entirely; `main.ts`
   * / `rehearsal-main.ts` never set this, so a real rehearsal always uses
   * the measured, run-sheet-accurate pace.
   */
  stepTargetMs?: Readonly<Record<DemoStepId, number>>;
};

/** Builds the rehearsal's step machine: identical keys and guards to `createDemoSession`, fixture-backed instead of network-backed. */
export function createRehearsalSession(deps: RehearsalSessionDeps): DemoSession {
  const onStatus = deps.onStatus ?? (() => {});
  const targetMs = deps.stepTargetMs ?? STEP_TARGET_MS;

  async function replayStep(step: DemoStepId): Promise<void> {
    const events = STEP_EVENTS[step];
    const perEventMs = events.length > 0 ? targetMs[step] / events.length : 0;
    for (const event of events) {
      if (perEventMs > 0) await delay(perEventMs);
      deps.push(event);
    }
  }

  return createStepMachine((ctx): StepRunners => {
    async function run(step: DemoStepId): Promise<void> {
      await replayStep(step);
      ctx.advance(step);
    }
    return {
      discover: () => run('discover'),
      pay: () => run('pay'),
      serve: () => run('serve'),
      challenge: () => run('challenge'),
    };
  }, onStatus);
}

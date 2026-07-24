/**
 * The event vocabulary the dashboard renders. See SPEC.md §7 (the loop) and
 * §10 (the 90s demo script this maps onto beat for beat).
 *
 * This is deliberately NOT wired to `@assay/core`: the dashboard is a sink,
 * not a driver (see README.md in this package). Whoever wires the live demo
 * (apps/mcp, apps/watchdog, apps/provider) emits `LoopEvent`s that shape as
 * these steps happen; this file owns only the shape, not the emission.
 */

/** The nine beats of the loop, in the fixed order they are always rendered. */
export type StepId =
  | 'register'
  | 'discover'
  | 'pay'
  | 'serve'
  | 'accept'
  | 'challenge'
  | 'verify'
  | 'slash'
  | 'reputation';

/** Rendering order. Every step is always shown, even ones an event sequence never reaches (they render as pending). */
export const STEP_ORDER: readonly StepId[] = [
  'register',
  'discover',
  'pay',
  'serve',
  'accept',
  'challenge',
  'verify',
  'slash',
  'reputation',
];

export const STEP_LABEL: Readonly<Record<StepId, string>> = {
  register: 'Register',
  discover: 'Discover',
  pay: 'Pay',
  serve: 'Serve',
  accept: 'Accept',
  challenge: 'Challenge',
  verify: 'Verify',
  slash: 'Slash',
  reputation: 'Reputation',
};

/**
 * A step moves through `running` (may be emitted zero or one times) then
 * lands on exactly one of `ok` / `failed`. A step an event sequence never
 * mentions stays `pending` in the rendered state; that is the "degrades
 * gracefully" requirement from issue #30 read the other way round, a step
 * that never started is not a frozen screen either.
 */
export type StepStatus = 'pending' | 'running' | 'ok' | 'failed';

/**
 * One independently-checkable artifact rendered under a step: a transaction
 * id, a HashScan URL, a block number, a claim's actual value, a reputation
 * score. Free-form strings on purpose (see issue #30: "anyone can verify
 * these independently"), the dashboard does not interpret them, only prints
 * them.
 */
export type Artifact = { label: string; value: string };

/**
 * One thing that happened during the loop. `status: 'running'` announces a
 * step has started (optional; a fixture may go straight to `ok`/`failed` for
 * fast steps); `'ok'`/`'failed'` are terminal for that step occurrence.
 * `summary` is the one-line human narration; `artifacts` are the real,
 * independently-verifiable values (SPEC.md §11: never fake these).
 */
export type LoopEvent = {
  step: StepId;
  status: StepStatus;
  summary: string;
  artifacts?: Artifact[];
};

/** The rendered state of one step: its latest known status plus whatever it last reported. */
export type StepState = {
  status: StepStatus;
  summary?: string;
  artifacts?: Artifact[];
};

/** The full rendered state of the loop: every step, most starting `pending`. */
export type LoopState = Readonly<Record<StepId, StepState>>;

/** A `LoopState` with every step `pending` and no summary/artifacts. The fold's starting point. */
export function initialLoopState(): LoopState {
  const state = {} as Record<StepId, StepState>;
  for (const step of STEP_ORDER) {
    state[step] = { status: 'pending' };
  }
  return state;
}

/**
 * Folds one event onto a state, replacing that step's entry wholesale (a
 * later event for the same step always wins; there is no merging of stale
 * artifacts onto a fresher status). Pure: returns a new state, never mutates
 * `state`.
 */
export function applyEvent(state: LoopState, event: LoopEvent): LoopState {
  return {
    ...state,
    [event.step]: {
      status: event.status,
      summary: event.summary,
      artifacts: event.artifacts,
    },
  };
}

/** Folds a whole event sequence into the resulting `LoopState`. What `render()` renders. */
export function reduceEvents(events: readonly LoopEvent[]): LoopState {
  return events.reduce(applyEvent, initialLoopState());
}

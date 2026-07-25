/**
 * The guard/advance state machine shared by the live session (`session.ts`)
 * and the offline rehearsal (`rehearsal.ts`). Both need the identical
 * "advancing is explicit, a running step cannot be restarted" behavior
 * (issue #86) over the same four-key sequence; only *what runs* for each key
 * differs (a real network call vs. a paced fixture replay). Factoring the
 * machine out once is what makes "the live path and rehearsal path render
 * identically" (issue #85) true of the *keyboard* behavior too, not just the
 * dashboard frame.
 */

export type DemoStepId = 'discover' | 'pay' | 'serve' | 'challenge';

export const STEP_KEYS: Readonly<Record<string, DemoStepId>> = {
  '1': 'discover',
  '2': 'pay',
  '3': 'serve',
  '4': 'challenge',
};

/** The fixed order the four keys must be pressed in. */
export const STEP_ORDER: readonly DemoStepId[] = ['discover', 'pay', 'serve', 'challenge'];

/** Reverse lookup into `STEP_KEYS`: which key triggers `step`. */
export function keyFor(step: DemoStepId): string {
  return Object.keys(STEP_KEYS).find((k) => STEP_KEYS[k] === step) ?? '?';
}

export type DemoSessionState = {
  /** The step this session is waiting for a keypress on. `'done'` once challenge has completed (successfully or not). */
  next: DemoStepId | 'done';
  /** True while a step's async work is in flight — guards against a stray keypress restarting it. */
  running: boolean;
};

export type DemoSession = {
  state(): Readonly<DemoSessionState>;
  /**
   * Handles one raw keypress. Fires the matching step's runner if (and only
   * if) it is the one currently expected and nothing is already running;
   * otherwise narrates why it was ignored via `onStatus` and does nothing
   * else.
   */
  handleKey(key: string): void;
};

export type StepRunners = Record<DemoStepId, () => Promise<void>>;

/**
 * Builds the shared machine over a set of per-step async `runners`. Each
 * runner is responsible for narrating its own step (pushing `LoopEvent`s,
 * calling `onStatus` on failure) and for calling the `advance(step)` it is
 * handed (via `buildRunners`'s `ctx`) exactly when that step should be
 * considered done — this machine never advances on its own, since "done"
 * is not always the same as "resolved without throwing": the live session's
 * pay step, for instance, resolves normally on a policy decline but must
 * *not* advance (the presenter can retry once the underlying reputation
 * changes). A runner that *throws* is always treated as a non-advancing
 * failure by this machine (caught centrally below, reported via
 * `onStatus`), so a runner only needs to call `advance` on its own genuine
 * success path and can let any other failure propagate as a rejection.
 *
 * This function only decides *when* a runner may start (`guard`) and
 * manages `state.running` around it; it has no opinion on what a runner
 * actually does.
 */
export function createStepMachine(
  buildRunners: (ctx: { advance(from: DemoStepId): void; onStatus: (message: string) => void }) => StepRunners,
  onStatus: (message: string) => void = () => {},
): DemoSession {
  const state: DemoSessionState = { next: 'discover', running: false };

  function advance(from: DemoStepId): void {
    const idx = STEP_ORDER.indexOf(from);
    state.next = idx + 1 < STEP_ORDER.length ? STEP_ORDER[idx + 1] : 'done';
    onStatus(state.next === 'done' ? 'demo complete — press q to quit.' : `press ${keyFor(state.next)} (${state.next}) next.`);
  }

  const runners = buildRunners({ advance, onStatus });

  function guard(step: DemoStepId): boolean {
    if (state.running) {
      onStatus(`still working on "${state.next}" — one moment.`);
      return false;
    }
    if (state.next === 'done') {
      onStatus('the demo has already run its course. Press q to quit.');
      return false;
    }
    if (step !== state.next) {
      onStatus(`press ${keyFor(state.next)} (${state.next}) first.`);
      return false;
    }
    return true;
  }

  return {
    state: () => ({ ...state }),
    handleKey(key: string): void {
      const step = STEP_KEYS[key];
      if (!step) return;
      if (!guard(step)) return;
      state.running = true;
      // Fire-and-forget on purpose: `handleKey` is called synchronously from
      // the raw-stdin listener (`keys.ts`) and must return immediately so
      // the terminal keeps reading input; `state.running` is what actually
      // prevents a second keypress from racing this one.
      void runners[step]()
        .catch((err: unknown) => {
          onStatus(`${step} failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          state.running = false;
        });
    },
  };
}

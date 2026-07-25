/**
 * The one HUD line at the top of every scenic frame (issue #94's layout).
 * Pure by construction: no clock of its own, every elapsed figure is passed
 * in already computed from `Date.now()` at render time, which is what makes
 * "nothing may look frozen" true structurally rather than case-by-case --
 * the caller recomputes and redraws on a bare wall-clock tick even when
 * neither stream has produced a new line (see the design doc's silence
 * strategy).
 *
 * The staleness threshold (default 15s) is chosen "comfortably past every
 * measured real gap between loop events" (the design doc's own words, cross
 * -checked against `docs/demo-run-sheet.md`'s measured numbers): once the
 * time since the last real loop-event line exceeds it, this degrades the
 * whole HUD into the warning form, which is the *only* signal a broken write
 * side ever produces on the read side (the two processes cannot otherwise
 * tell each other apart from "just quiet for now").
 */

export type HudOptions = {
  /** Wall-clock ms since the run started. */
  elapsedMs: number;
  /** Ms since the last real loop-event line was seen, or `undefined` if none has arrived yet this run. */
  loopLastEventAgoMs?: number;
  /** True for an offline rehearsal replay -- declared on screen, never left ambiguous (a hard requirement: "An offline rehearsal... declared as a replay on screen"). */
  replay: boolean;
  /** A short run identifier (e.g. a random id or the capture file's own basename), shown so a presenter can point at a specific run. */
  runLabel: string;
  /** Defaults to 15000ms. */
  staleThresholdMs?: number;
};

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatAgo(ms: number): string {
  if (ms < 1000) return '<1s ago';
  return `${(ms / 1000).toFixed(0)}s ago`;
}

/** Renders the HUD line. Never throws, never invents a percentage or a phase that isn't backed by a real fact. */
export function renderHud(opts: HudOptions): string {
  const staleThreshold = opts.staleThresholdMs ?? 15_000;
  const title = opts.replay ? 'ASSAY — REPLAY (offline rehearsal)' : 'ASSAY — scenic run';
  const elapsed = `elapsed ${formatClock(opts.elapsedMs)}`;

  let loopStatus: string;
  if (opts.loopLastEventAgoMs === undefined) {
    loopStatus = 'loop-events: none yet';
  } else if (opts.loopLastEventAgoMs > staleThreshold) {
    loopStatus = `⚠ loop-events: ${formatAgo(opts.loopLastEventAgoMs)} (stale)`;
  } else {
    loopStatus = `loop-events: ${formatAgo(opts.loopLastEventAgoMs)}`;
  }

  return `${title} ${opts.runLabel}   ${elapsed}   ${loopStatus}`;
}

/** True once `loopLastEventAgoMs` exceeds the stale threshold -- the one signal that degrades the whole frame (see the design doc's "degraded frame"), exported so the runner can also decide whether to print the longer warning footer. */
export function isLoopStreamStale(loopLastEventAgoMs: number | undefined, staleThresholdMs = 15_000): boolean {
  return loopLastEventAgoMs !== undefined && loopLastEventAgoMs > staleThresholdMs;
}

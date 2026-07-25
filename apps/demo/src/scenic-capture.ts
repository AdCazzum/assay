/**
 * The offline-rehearsal artifact (issue #94's required "replay a captured
 * real run at the same pace, declared as a replay on screen"). One merged
 * format, `.scenic.ndjson`, graft from the judged design's "Proposal 0":
 * `{ source: 'agent' | 'loop', recordedAtMs, payload }`, one file, cleaner
 * than juggling two paired files whose relative timing would otherwise have
 * to be reconciled separately at replay time.
 *
 * `recordedAtMs` is relative to the run's own start (`Date.now()` at the
 * first record is `0`), not a wall-clock timestamp -- a replay re-emits each
 * record after waiting exactly the gap between it and the previous record's
 * `recordedAtMs`, which is what "at the same pace" means concretely: the
 * replay's own silences are exactly as long as the live run's were, not
 * approximated or evenly spaced.
 *
 * `payload` is the exact raw line each source produced (a raw agent
 * stream-json line, or a raw sink NDJSON line) -- captured before parsing,
 * not after, so a capture is provably a recording of the wire, not of this
 * app's own interpretation of it.
 */

import { appendFileSync, readFileSync } from 'node:fs';

export type ScenicSource = 'agent' | 'loop';

export type ScenicRecord = {
  source: ScenicSource;
  /** Ms since the run started (relative, not wall-clock -- see the module doc comment). */
  recordedAtMs: number;
  /** The raw line as received from that source, unparsed. */
  payload: string;
};

export type ScenicRecorder = {
  /** Appends one record. Never throws: a capture failing to write must not break the live run it is recording (same posture as the loop-event sink this whole demo already depends on). */
  record(source: ScenicSource, payload: string): void;
};

/**
 * Builds a recorder that writes to `path` (append-only, one JSON line per
 * record) and stamps `recordedAtMs` relative to `startedAtMs` (defaults to
 * `Date.now()` at construction). Synchronous (`appendFileSync`): the capture
 * file is small (NDJSON lines, not media) and this runs in the same process
 * already doing its own polling/redraw loop, so there is no throughput
 * concern that would justify the complexity of a buffered async writer here.
 */
export function createScenicRecorder(path: string, startedAtMs: number = Date.now()): ScenicRecorder {
  let broken = false;
  return {
    record(source, payload) {
      if (broken) return;
      try {
        const record: ScenicRecord = { source, recordedAtMs: Date.now() - startedAtMs, payload };
        appendFileSync(path, `${JSON.stringify(record)}\n`);
      } catch {
        broken = true;
      }
    },
  };
}

/** Reads a `.scenic.ndjson` file back into its records, in file order. Throws if `path` cannot be read -- a rehearsal with no capture to replay is a real failure, unlike the live sink's "not written yet" non-error. */
export function readScenicCapture(path: string): ScenicRecord[] {
  const raw = readFileSync(path, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ScenicRecord);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ReplayOptions = {
  /** Speeds up (>1) or slows down (<1) the replay relative to its recorded pace. Defaults to 1 (exactly as recorded). Tests use this to avoid a real-time-length test run. */
  speed?: number;
};

/**
 * Replays `records` in order, calling `onRecord` for each after waiting the
 * real gap since the previous record (scaled by `opts.speed`). This is the
 * entire "at the same pace" mechanism: no separate per-step target durations
 * (unlike the old keypress rehearsal's `STEP_TARGET_MS`), because the merged
 * capture format already carries the real, measured gaps directly.
 */
export async function replayScenicCapture(
  records: readonly ScenicRecord[],
  onRecord: (record: ScenicRecord) => void,
  opts: ReplayOptions = {},
): Promise<void> {
  const speed = opts.speed ?? 1;
  let previousAtMs = 0;
  for (const record of records) {
    const gapMs = record.recordedAtMs - previousAtMs;
    if (gapMs > 0) await delay(gapMs / speed);
    onRecord(record);
    previousAtMs = record.recordedAtMs;
  }
}

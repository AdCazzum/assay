/**
 * Polls `apps/mcp`'s NDJSON loop-event sink (issue #93) from a second
 * process, and turns each raw line into a typed fact this app's own render
 * pipeline folds. 100ms polling was chosen over `fs.watch`/inotify
 * deliberately (documented cross-platform gaps in Node's watch API): the
 * cost is a little wasted CPU and a soft ~100ms display lag, imperceptible
 * next to the multi-second real latencies this whole demo already measures
 * (`docs/demo-run-sheet.md`), but worth naming as a real, non-zero cost
 * rather than "free" (see the design doc's own "accepted tradeoffs").
 *
 * **Chunk boundaries do not align with lines**, exactly the same fact
 * `apps/mcp/scripts/run-agent.ts` already had to handle for the agent's own
 * stdout: a poll can read a partial trailing line, so `splitLines` holds the
 * remainder across polls rather than assuming one read = whole lines.
 *
 * **The sink file not existing yet is a normal pre-run state, not an
 * error**: `apps/mcp`'s server opens it lazily on its first `onLoopEvent`
 * call, so this tailer starts polling before that file exists and treats
 * `ENOENT` as "nothing to read yet", not a failure — only reported to
 * `onError` for any other `stat`/`read` failure (a permission error, a
 * deleted-mid-run file after it existed once).
 */

import { open, stat } from 'node:fs/promises';

/**
 * Splits `buffered + chunk` on newlines, returning every complete line and
 * the (possibly empty) partial trailing remainder to prepend to the next
 * chunk. Blank lines are dropped (matching `run-agent.ts`'s own `if
 * (part.trim())` filter) rather than handed to the caller as empty facts.
 */
export function splitLines(buffered: string, chunk: string): { lines: string[]; remainder: string } {
  const combined = buffered + chunk;
  const parts = combined.split('\n');
  const remainder = parts.pop() ?? '';
  return { lines: parts.filter((line) => line.trim().length > 0), remainder };
}

export type SinkTailerOptions = {
  path: string;
  /** Called once per complete NDJSON line, in file order. */
  onLine: (raw: string) => void;
  /** Called on any read failure other than the sink file not existing yet. Never called for ENOENT. */
  onError?: (err: unknown) => void;
  /** Defaults to 100ms. */
  intervalMs?: number;
};

export type SinkTailerHandle = {
  /** Stops polling. Safe to call more than once. */
  stop(): void;
};

/**
 * Starts polling `opts.path` immediately (one poll right away, then every
 * `intervalMs`) and returns a handle to stop. Picks up mid-run with no
 * coordination needed: the first poll simply reads from offset 0, so
 * starting the tailer before or after the writer has opened the file both
 * work the same way (issue #93: "a reader can tail it without
 * coordination").
 */
export function startSinkTailer(opts: SinkTailerOptions): SinkTailerHandle {
  const intervalMs = opts.intervalMs ?? 100;
  let offset = 0;
  let buffered = '';
  let stopped = false;
  let polling = false;

  async function pollOnce(): Promise<void> {
    if (polling || stopped) return;
    polling = true;
    try {
      const info = await stat(opts.path);
      // `stopped` can flip to true while this very call was already awaiting
      // `stat()` above (a poll that started a moment before `stop()` was
      // called does not abort mid-flight, it just must not surface stale
      // results once it resolves): re-check right after every await, before
      // this poll has any observable effect (an `onLine` call, or advancing
      // `offset`/`buffered` past what a subsequent, legitimate poll would
      // otherwise have read).
      if (stopped) return;
      if (info.size > offset) {
        const length = info.size - offset;
        const fh = await open(opts.path, 'r');
        try {
          if (stopped) return;
          const buf = Buffer.alloc(length);
          await fh.read(buf, 0, length, offset);
          if (stopped) return;
          offset = info.size;
          const { lines, remainder } = splitLines(buffered, buf.toString('utf8'));
          buffered = remainder;
          for (const line of lines) opts.onLine(line);
        } finally {
          await fh.close();
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        opts.onError?.(err);
      }
    } finally {
      polling = false;
    }
  }

  const timer = setInterval(() => {
    void pollOnce();
  }, intervalMs);
  void pollOnce();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Parses one raw sink line into whichever of the two shapes it is (see
 * `apps/mcp/src/loop-event-sink.ts`): a real `LoopEvent` (has `step`, never
 * `kind`) or a `kind: 'heartbeat'` line (never `step`). Deliberately loose
 * rather than importing `@assay/core`'s `LoopEvent` union or
 * `@assay/mcp`'s heartbeat types: this app renders best-effort off whatever
 * shape actually arrives on the wire (the same posture
 * `apps/mcp/scripts/run-agent.ts` already takes on the agent's own
 * stream-json), and a cross-app type import here would be the one new
 * workspace dependency this file would otherwise force.
 */
export type ParsedSinkLine =
  | { kind: 'loop-event'; event: Record<string, unknown> }
  | { kind: 'heartbeat'; heartbeat: Record<string, unknown> }
  | { kind: 'unparsable'; raw: string };

export function parseSinkLine(raw: string): ParsedSinkLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'unparsable', raw };
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (obj.kind === 'heartbeat') return { kind: 'heartbeat', heartbeat: obj };
    if (typeof obj.step === 'string') return { kind: 'loop-event', event: obj };
  }
  return { kind: 'unparsable', raw };
}

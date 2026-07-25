/**
 * The NDJSON event sink (issue #93). `claude` spawns this MCP server over
 * stdio, so the server runs in a different process from anything that would
 * display its `LoopEvent`s, and stdout is the MCP JSON-RPC transport, so it
 * cannot carry them either (see `index.ts`'s own comment on this, and
 * `AGENTS.md`'s hard rule: "Never write to stdout from the MCP server").
 *
 * `createLoopEventSink(path, stamp)` opens `path` once, append-only, and
 * returns two write functions plus a `close()`. Both write functions are
 * **fire-and-forget and never throw**: a sink that cannot be written to (an
 * unwritable path, a full disk, a permission revoked mid-run) must not break
 * a tool call — the agent's `pay_and_call` still pays real HBAR and still
 * runs the capability; only the narration goes dark. That is the whole
 * "failing event sink must not break a tool call" requirement, and it is
 * proven by `loop-event-sink.test.ts` against a genuinely unwritable path.
 *
 * **Why the explicit `stream.on('error', ...)` listener is load-bearing, not
 * just defense-in-depth.** A `Writable`'s `write()` can fail two different
 * ways: synchronously (rare; e.g. a bad argument) and asynchronously, by
 * emitting an `'error'` event on the stream once the underlying fd operation
 * actually fails (the common case for a real filesystem error, which surfaces
 * on the write's own callback/next tick, not synchronously inside `write()`
 * itself). A bare `try/catch` around `stream.write(...)` only ever catches
 * the first kind. An unhandled `'error'` event on a Node stream is fatal by
 * default — it throws on the next tick and crashes the process — so without
 * this listener, an unwritable sink path would not just fail to narrate, it
 * would kill the agent's whole run, including any in-flight payment. The
 * listener is what turns that into "narration silently stops" instead.
 *
 * Two line shapes share one file, distinguished by `kind` (see
 * `SinkHeartbeatLine`): a real `LoopEvent` (from `@assay/core`, has `step`,
 * never `kind`) and a `kind: 'heartbeat'` line this file adds on top of what
 * issue #93 literally asked for (see the design doc's own "accepted
 * tradeoffs" on why: without it, the 8-25s ENS reputation write -- the single
 * longest deterministic silence in the whole demo -- would have nothing
 * narrating it across the process boundary). Both share the exact same
 * `at`/`seq` stamper `@assay/core`'s `createLiveAssayNode` was built with, so
 * `seq` stays one strictly-increasing sequence across both kinds of line,
 * same as it already is across a node's own emitted events and
 * `live-node.ts`'s synthetic `rate()` ones.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import type { EnsWriteAttemptState } from '@assay/registry';
import type { LoopEvent, LoopEventVariant } from '@assay/core';

/**
 * The reputation-write heartbeat line (issue #93's companion wire): mirrors
 * `@assay/registry`'s own `ReputationWriteProgress`, tagged so a tailer can
 * tell it apart from a real `LoopEvent` without ambiguity (`kind` is present
 * here, absent on every `LoopEvent` line).
 */
export type ReputationHeartbeatLine = {
  kind: 'heartbeat';
  of: 'reputation-write';
  phase: 'reading' | 'writing' | 'done';
  writeState?: EnsWriteAttemptState;
  elapsedMs: number;
  txHash?: string;
};

/**
 * The payment-confirm heartbeat line (graft from Proposal 1, see the design
 * doc's "take from Proposal 1" section: lower priority than the reputation
 * one since payment confirm is measured at ~4s not 8-25s, but cheap to add
 * given both hooks share this same sink mechanism).
 */
export type PaymentConfirmHeartbeatLine = {
  kind: 'heartbeat';
  of: 'payment-confirm';
  attempt: number;
  elapsedMs: number;
  state: string;
};

export type SinkHeartbeatLine = ReputationHeartbeatLine | PaymentConfirmHeartbeatLine;

/** What a heartbeat line looks like once stamped with `at`/`seq`, the same base every `LoopEvent` carries. */
export type StampedSinkHeartbeat = SinkHeartbeatLine & { at: number; seq: number };

export type LoopEventSink = {
  /**
   * Appends an already-stamped `LoopEvent` as one NDJSON line. Never throws; a
   * no-op once the sink has broken. Takes the *stamped* event, not a bare
   * `LoopEventVariant` body: `AssayNodeConfig.onLoopEvent` (the hook this is
   * wired to in `index.ts`) is always invoked with the full, already-stamped
   * `LoopEvent` (`node.ts`'s `safeEmit` calls `stamp(body)` before invoking
   * it) -- re-stamping it here would both waste a `seq` value on every call
   * (the shared counter still advances) and, since `createEventStamper`'s
   * `{ at: Date.now(), seq, ...body }` spread lets an already-present `at`/
   * `seq` on `body` win, silently keep the *original* stamp instead of a
   * fresh one -- confusing either way. So this only serializes, it never
   * calls `stamp` again.
   */
  sinkLoopEvent(event: LoopEvent): void;
  /**
   * Stamps a heartbeat line (no `step`, so it cannot go through `stamp`
   * itself, which is typed for `LoopEventVariant`) using the same shared
   * counter, and appends it the same way. Never throws.
   */
  sinkHeartbeat(body: SinkHeartbeatLine): void;
  /**
   * Ends the underlying write stream. Safe to call even if the sink already
   * broke. `onFinish`, if given, fires once the stream has actually flushed
   * to disk (or immediately, if the sink never opened) -- `fs.createWriteStream`
   * opens and flushes asynchronously, so a caller that needs to know "the
   * file now has everything written" (tests; a graceful-shutdown path) should
   * pass this rather than assuming `close()` returning means the bytes landed.
   */
  close(onFinish?: () => void): void;
};

/**
 * `createEventStamper()`'s returned closure is typed to accept only
 * `LoopEventVariant` (a `step`-tagged union), but its actual implementation
 * (`events.ts`) is just `{ at: Date.now(), seq, ...body }` -- it does not
 * inspect `body` beyond spreading it, so reusing the exact same counter for a
 * heartbeat line (which deliberately has no `step`, see `SinkHeartbeatLine`)
 * is safe at runtime even though it is not expressible in the stamper's own
 * declared type. This narrow cast is what "reuses the exact same shared
 * stamp() closure so seq stays coherent across both" (the design doc's own
 * words) actually means in code, rather than two independent counters that
 * would not interleave correctly.
 */
type RawStamp = (body: Record<string, unknown>) => { at: number; seq: number };

/**
 * Builds the sink. `path` is opened once, append-only (`flags: 'a'`), so a
 * tailer can start reading before this process has written anything and pick
 * up mid-run (issue #93: "a reader can tail it without coordination").
 * `stamp` should be the *same* `createEventStamper()` instance passed to
 * `createLiveAssayNode({ eventStamper: stamp })`, so this sink's own
 * heartbeat lines share one strictly-increasing `seq` with the real
 * `LoopEvent`s that same stamper produces (`sinkLoopEvent` itself does not
 * call `stamp` -- see its own doc comment -- only `sinkHeartbeat` does).
 */
export function createLoopEventSink(
  path: string,
  stamp: (body: LoopEventVariant) => LoopEvent,
): LoopEventSink {
  const rawStamp = stamp as unknown as RawStamp;

  let broken = false;
  let stream: WriteStream;
  try {
    stream = createWriteStream(path, { flags: 'a' });
  } catch {
    // Synchronous construction failure (e.g. the parent directory does not
    // exist and never will): treat exactly like a stream that broke later --
    // every write below becomes a silent no-op.
    broken = true;
    stream = null as unknown as WriteStream;
  }
  stream?.on('error', () => {
    broken = true;
  });

  function writeLine(line: Record<string, unknown>): void {
    if (broken) return;
    try {
      stream.write(`${JSON.stringify(line)}\n`);
    } catch {
      broken = true;
    }
  }

  return {
    sinkLoopEvent(event) {
      writeLine(event);
    },
    sinkHeartbeat(body) {
      writeLine(rawStamp(body));
    },
    close(onFinish) {
      try {
        if (stream) {
          stream.end(onFinish);
        } else {
          onFinish?.();
        }
      } catch {
        // Already broken/closed -- nothing left to do.
        onFinish?.();
      }
    },
  };
}

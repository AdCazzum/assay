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

import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { EnsWriteAttemptState } from '@assay/registry';
import type { LoopEvent, LoopEventVariant } from '@assay/core';
import {
  advanceChain,
  ANCHORED_STEPS,
  ANCHOR_GENESIS,
  ANCHOR_VERSION,
  FINAL_ANCHOR_STEP,
  RUN_LINE_KIND,
  type LoopAnchorRecord,
} from './loop-anchor.js';

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
   * The running SHA-256 chain over every line written so far (see
   * `loop-anchor.ts`). Exposed for tests and for a caller that wants to print
   * the digest a reader can check the file against.
   */
  chainHead(): string;
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
export type LoopEventSinkOptions = {
  /**
   * Receives an anchor whenever the chain head should be committed to
   * consensus: on the first line of each value-moving or truth-settling step
   * (`ANCHORED_STEPS`), and once more from `close()` for whatever came after
   * the last of those. Wired to `createLoopAnchor(...).anchor` in `index.ts`;
   * omitted, the sink still chains, it just publishes nothing — which is the
   * right behaviour with no topic configured, and keeps every existing test
   * and the offline dashboard replay working untouched.
   */
  onAnchor?(record: LoopAnchorRecord): void;
};

export function createLoopEventSink(
  path: string,
  stamp: (body: LoopEventVariant) => LoopEvent,
  options: LoopEventSinkOptions = {},
): LoopEventSink {
  const onAnchor = options.onAnchor;
  const rawStamp = stamp as unknown as RawStamp;
  // Identifies this run in an append-only file that accumulates many. Random
  // rather than a counter or a timestamp: two processes may append to the same
  // file, and the id only has to be unique, never ordered.
  const runId = randomBytes(8).toString('hex');

  let broken = false;
  // Anchor state. `spanStart >= 0` doubles as "there are lines not yet
  // covered by a published anchor", which is what tells `close()` whether a
  // final anchor is owed.
  let chain = ANCHOR_GENESIS;
  let spanStart = -1;
  let lastSeq = -1;
  let lastAnchoredStep: string | undefined;
  let stream: WriteStream;
  try {
    // Create the parent directory rather than treating a missing one as a
    // broken sink. This is the failure that actually happened: the configured
    // path was relative, `pnpm --filter exec` runs with cwd at the package
    // directory rather than the repo root, so the parent did not exist and
    // every write became a silent no-op for a whole live run.
    mkdirSync(dirname(path), { recursive: true });
    stream = createWriteStream(path, { flags: 'a' });
  } catch {
    // Synchronous construction failure (e.g. the parent directory does not
    // exist and never will): treat exactly like a stream that broke later --
    // every write below becomes a silent no-op.
    broken = true;
    stream = null as unknown as WriteStream;
  }
  stream?.on('error', (err) => {
    broken = true;
    // stderr, never stdout: stdout is the MCP JSON-RPC channel. Saying nothing
    // was the real defect here, not the failure itself. "Never throws" is the
    // right behaviour for a narration sink; "never mentions it" means a
    // misconfigured sink looks identical to a working one, which is how a whole
    // live run went unrecorded.
    process.stderr.write(`[assay] loop-event sink failed, narration is off: ${err.message}\n`);
  });

  if (broken) {
    process.stderr.write(`[assay] loop-event sink could not open "${path}", narration is off\n`);
  } else {
    process.stderr.write(`[assay] loop-event sink writing to ${resolve(path)}\n`);
  }

  // The run header, written before anything else so it is line one of this
  // run's segment and therefore the first link in its chain. It is what lets
  // `scripts/verify-anchors.ts` split an append-only log back into runs
  // exactly, and pair each anchor with the segment it came from.
  writeLine(rawStamp({ kind: RUN_LINE_KIND, run: runId }));

  function writeLine(line: Record<string, unknown>): void {
    if (broken) return;
    const json = JSON.stringify(line);

    // The chain advances in write order, which is the order the bytes reach
    // the file, so it is computed here rather than in the callback below --
    // a later synchronous write must not chain ahead of an earlier pending one.
    const next = advanceChain(chain, json);
    const seq = typeof line.seq === 'number' ? line.seq : lastSeq;
    const step = typeof line.step === 'string' ? line.step : undefined;

    // One anchor per entry into a step, not per event: `pay` alone emits a
    // `confirming` line every mirror-node poll, and anchoring each would spend
    // a consensus message per second of lag for no extra evidence.
    const anchoring: LoopAnchorRecord | undefined =
      onAnchor && step && ANCHORED_STEPS[step] === true && step !== lastAnchoredStep
        ? {
            v: ANCHOR_VERSION,
            run: runId,
            seq,
            from: spanStart < 0 ? seq : spanStart,
            step,
            chain: next,
          }
        : undefined;

    try {
      // Publishing from the write callback, not straight after `write()`,
      // is the difference between attesting bytes and attesting intent.
      // `write()` returning does not mean the line landed: a stream whose
      // fd never opened (ENOENT, permissions revoked mid-run, a full disk)
      // buffers the chunk happily and only reports the failure on this
      // callback, one tick later. An anchor published optimistically in that
      // window commits to a line no verifier can ever read back, which shows
      // up downstream as a chain mismatch -- indistinguishable from someone
      // having edited the log. A missing anchor is an honest gap; a wrong one
      // is an accusation.
      stream.write(
        `${json}\n`,
        anchoring
          ? (err) => {
              if (!err && !broken) onAnchor?.(anchoring);
            }
          : undefined,
      );
    } catch {
      broken = true;
      return;
    }

    chain = next;
    lastSeq = seq;
    spanStart = anchoring ? -1 : spanStart < 0 ? seq : spanStart;
    if (anchoring) lastAnchoredStep = step;
  }

  return {
    sinkLoopEvent(event) {
      writeLine(event);
    },
    sinkHeartbeat(body) {
      writeLine(rawStamp(body));
    },
    chainHead() {
      return chain;
    },
    close(onFinish) {
      // The final anchor is what makes the chain cover the *whole* file: the
      // step-triggered ones stop at the last `slash`/`verify`, and everything
      // written after it (ratings, trailing heartbeats) would otherwise be
      // attested by nothing. Nothing is owed when the last line was itself an
      // anchor, which `spanStart` already encodes -- and the same guard means
      // a second `close()` cannot publish a duplicate.
      //
      // Emitted from inside the stream's own finish callback for the same
      // reason `writeLine` publishes from the write callback: at that point
      // every buffered line has actually been flushed. `onFinish` runs after
      // it, so a caller draining the anchor queue there (see
      // `apps/mcp/src/index.ts`'s shutdown hook) drains this one too.
      const publishFinal = () => {
        if (!onAnchor || broken || spanStart < 0) return;
        onAnchor({
          v: ANCHOR_VERSION,
          run: runId,
          seq: lastSeq,
          from: spanStart,
          step: FINAL_ANCHOR_STEP,
          chain,
        });
        spanStart = -1;
      };
      try {
        if (stream) {
          stream.end(() => {
            publishFinal();
            onFinish?.();
          });
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

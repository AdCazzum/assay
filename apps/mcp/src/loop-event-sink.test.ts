import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventStamper } from '@assay/core';
import { createLoopEventSink } from './loop-event-sink.js';

/** `close()` flushes asynchronously (`fs.createWriteStream` opens/writes async); wait for it before reading the file back. */
function closeAndWait(sink: { close(onFinish?: () => void): void }): Promise<void> {
  return new Promise((resolve) => sink.close(resolve));
}

describe('createLoopEventSink (issue #93)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'assay-loop-sink-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes each already-stamped LoopEvent as one NDJSON line, unchanged', async () => {
    // `sinkLoopEvent` is wired to `AssayNodeConfig.onLoopEvent`, which
    // core's `safeEmit` always calls with an *already-stamped* LoopEvent
    // (`stamp(body)` happens before the hook fires) -- so the sink itself
    // must not stamp again, only serialize. Simulate that real call shape
    // here: stamp first, exactly like node.ts does, then hand the result to
    // the sink.
    const sinkPath = path.join(dir, 'events.ndjson');
    const stamp = createEventStamper();
    const sink = createLoopEventSink(sinkPath, stamp);

    const first = stamp({ step: 'discover', outcome: 'ok', name: 'rugscore.assay.eth', provider: {} as never });
    const second = stamp({ step: 'pay', phase: 'paid', name: 'rugscore.assay.eth', txId: '0.0.1@1', amountHbar: 5 });
    sink.sinkLoopEvent(first);
    sink.sinkLoopEvent(second);
    await closeAndWait(sink);

    const lines = readFileSync(sinkPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual(first);
    expect(lines[1]).toEqual(second);
    expect(lines[0].seq).toBe(1);
    expect(lines[1].seq).toBe(2);
  });

  it('shares one strictly-increasing seq between real LoopEvents and heartbeat lines', async () => {
    const sinkPath = path.join(dir, 'events.ndjson');
    const stamp = createEventStamper();
    const sink = createLoopEventSink(sinkPath, stamp);

    sink.sinkLoopEvent(stamp({ step: 'discover', outcome: 'ok', name: 'x', provider: {} as never }));
    sink.sinkHeartbeat({ kind: 'heartbeat', of: 'reputation-write', phase: 'writing', writeState: 'pending', elapsedMs: 3000 });
    sink.sinkLoopEvent(stamp({ step: 'pay', phase: 'confirming', txId: 't' }));
    await closeAndWait(sink);

    const lines = readFileSync(sinkPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(lines[1].kind).toBe('heartbeat');
    expect(lines[0].kind).toBeUndefined();
    expect(lines[2].kind).toBeUndefined();
  });

  it('a heartbeat line never carries "step" and a real LoopEvent line never carries "kind" (the tailer\'s disambiguator)', async () => {
    const sinkPath = path.join(dir, 'events.ndjson');
    const stamp = createEventStamper();
    const sink = createLoopEventSink(sinkPath, stamp);
    sink.sinkHeartbeat({ kind: 'heartbeat', of: 'payment-confirm', attempt: 1, elapsedMs: 500, state: 'pending' });
    await closeAndWait(sink);
    const [line] = readFileSync(sinkPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(line.step).toBeUndefined();
    expect(line.kind).toBe('heartbeat');
  });

  it('an unwritable sink path never throws from sinkLoopEvent/sinkHeartbeat, and silently becomes a no-op', () => {
    // A path under a directory that does not exist and is never created: the
    // underlying write stream's 'error' event fires asynchronously. This is
    // the exact "unwritable path" scenario issue #93 requires proof against:
    // a failing sink must not break the caller (the agent's real tool call).
    const unwritablePath = path.join(dir, 'does-not-exist', 'nested', 'events.ndjson');
    const stamp = createEventStamper();
    const sink = createLoopEventSink(unwritablePath, stamp);

    expect(() =>
      sink.sinkLoopEvent(stamp({ step: 'discover', outcome: 'ok', name: 'x', provider: {} as never })),
    ).not.toThrow();
    expect(() =>
      sink.sinkHeartbeat({ kind: 'heartbeat', of: 'reputation-write', phase: 'reading', elapsedMs: 0 }),
    ).not.toThrow();
    expect(() => sink.close()).not.toThrow();
  });

  it('an unwritable sink path does not crash the process (no unhandled stream "error" event)', async () => {
    // The load-bearing case: without the explicit `.on('error', ...)` listener
    // documented in loop-event-sink.ts, an unhandled Writable 'error' event
    // throws asynchronously and takes the whole process down -- a try/catch
    // around write() alone cannot catch that. Proven here by waiting a real
    // tick past the write call and asserting nothing escaped as an unhandled
    // rejection/exception in that window.
    const unwritablePath = path.join(dir, 'also-does-not-exist', 'events.ndjson');
    const stamp = createEventStamper();
    const sink = createLoopEventSink(unwritablePath, stamp);

    let uncaught: unknown;
    const onUncaught = (err: unknown) => {
      uncaught = err;
    };
    process.once('uncaughtException', onUncaught);

    sink.sinkLoopEvent(stamp({ step: 'pay', phase: 'paid', name: 'x', txId: 't', amountHbar: 1 }));
    // Give the stream's async error a real chance to surface.
    await new Promise((resolve) => setTimeout(resolve, 50));

    process.removeListener('uncaughtException', onUncaught);
    expect(uncaught).toBeUndefined();
  });
});

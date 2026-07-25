import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventStamper } from '@assay/core';
import type { HederaTopicClient } from '@assay/payments';

import {
  advanceChain,
  ANCHOR_GENESIS,
  ANCHOR_VERSION,
  createLoopAnchor,
  FINAL_ANCHOR_STEP,
  type LoopAnchorRecord,
} from './loop-anchor.js';
import { createLoopEventSink } from './loop-event-sink.js';

/** `close()` flushes asynchronously; wait for it before reading the file back. */
function closeAndWait(sink: { close(onFinish?: () => void): void }): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  sink.close(resolve);
  return promise;
}

/**
 * Reads the `seq` off a line the sink wrote, or off an anchor record. Both
 * shapes are ours and one field deep, so narrowing beats a schema here — but
 * it does have to be narrowed: an inline cast would silently read `undefined`
 * if the shape ever drifted, and every assertion below would still pass.
 */
function seqOf(json: string): number {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || !('seq' in parsed) || typeof parsed.seq !== 'number') {
    throw new Error(`no numeric seq in: ${json}`);
  }
  return parsed.seq;
}

/** Replays a written NDJSON file exactly the way `scripts/verify-anchors.ts` does. */
function replayChain(filePath: string): { head: string; headBySeq: Map<number, string> } {
  const headBySeq = new Map<number, string>();
  let head = ANCHOR_GENESIS;
  for (const line of readFileSync(filePath, 'utf8').split('\n').filter(Boolean)) {
    head = advanceChain(head, line);
    headBySeq.set(seqOf(line), head);
  }
  return { head, headBySeq };
}

describe('advanceChain', () => {
  it('is order-dependent, so reordering two lines changes the head', () => {
    const a = advanceChain(advanceChain(ANCHOR_GENESIS, '{"seq":0}'), '{"seq":1}');
    const b = advanceChain(advanceChain(ANCHOR_GENESIS, '{"seq":1}'), '{"seq":0}');
    expect(a).not.toEqual(b);
  });

  it('propagates a change in any earlier line to every later head', () => {
    // The whole tamper-evidence claim rests on this: editing line 0 must not
    // leave the head after line 2 intact, or a rewritten log could still
    // reproduce an anchor that was stamped later in the run.
    const honest = ['{"seq":0,"v":1}', '{"seq":1}', '{"seq":2}'];
    const tampered = ['{"seq":0,"v":2}', '{"seq":1}', '{"seq":2}'];
    const fold = (lines: string[]) => lines.reduce(advanceChain, ANCHOR_GENESIS);
    expect(fold(tampered)).not.toEqual(fold(honest));
  });
});

describe('createLoopEventSink anchoring', () => {
  let dir: string;
  let sinkPath: string;
  let anchors: LoopAnchorRecord[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'assay-anchor-'));
    sinkPath = join(dir, 'events.ndjson');
    anchors = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('anchors once per entry into a value-moving step, not once per event', async () => {
    const stamp = createEventStamper();
    const sink = createLoopEventSink(sinkPath, stamp, { onAnchor: (r) => anchors.push(r) });

    // `discover` is deliberately not anchored; `pay` emits several lines while
    // the mirror node confirms, and all of them belong to one anchor.
    sink.sinkLoopEvent(stamp({ step: 'discover', outcome: 'ok', name: 'x', provider: {} as never }));
    sink.sinkLoopEvent(stamp({ step: 'pay', phase: 'confirming', txId: 't' }));
    sink.sinkHeartbeat({ kind: 'heartbeat', of: 'payment-confirm', attempt: 1, elapsedMs: 500, state: 'pending' });
    sink.sinkLoopEvent(stamp({ step: 'pay', phase: 'paid', name: 'x', txId: 't', amountHbar: 5 }));
    sink.sinkLoopEvent(stamp({ step: 'serve', outcome: 'ok', jobId: 'j1' } as never));
    await closeAndWait(sink);

    // No `close` anchor: the last line written was itself the `serve` anchor,
    // so a final one would republish an identical chain head.
    expect(anchors.map((a) => a.step)).toEqual(['pay', 'serve']);
    // The first anchor covers the run header and the `discover` line too: the
    // chain is over every line, the step only decides when the head gets
    // published. `seq` starts at 1 and the run header takes it, so `discover`
    // is 2 and `pay/confirming` is 3.
    expect(anchors[0]).toMatchObject({ v: ANCHOR_VERSION, from: 1, seq: 3 });
    expect(anchors[1]).toMatchObject({ from: 4, seq: 6 });
    // Every anchor carries the run it came from, which is what pairs it with
    // this file's segment when one topic carries many runs.
    expect(new Set(anchors.map((a) => a.run)).size).toBe(1);
    expect(anchors[0].run).toMatch(/^[0-9a-f]{16}$/);
  });

  it('every anchored chain reproduces from the file the sink wrote', async () => {
    const stamp = createEventStamper();
    const sink = createLoopEventSink(sinkPath, stamp, { onAnchor: (r) => anchors.push(r) });

    sink.sinkLoopEvent(stamp({ step: 'discover', outcome: 'ok', name: 'x', provider: {} as never }));
    sink.sinkLoopEvent(stamp({ step: 'pay', phase: 'paid', name: 'x', txId: 't', amountHbar: 5 }));
    sink.sinkLoopEvent(stamp({ step: 'challenge', outcome: 'upheld', jobId: 'j1' } as never));
    sink.sinkLoopEvent(stamp({ step: 'slash', amountHbar: 5, txId: 's' } as never));
    await closeAndWait(sink);

    const { headBySeq } = replayChain(sinkPath);
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(headBySeq.get(anchor.seq)).toEqual(anchor.chain);
    }
  });

  it('the final anchor covers lines written after the last anchored step', async () => {
    const stamp = createEventStamper();
    const sink = createLoopEventSink(sinkPath, stamp, { onAnchor: (r) => anchors.push(r) });

    sink.sinkLoopEvent(stamp({ step: 'slash', amountHbar: 5, txId: 's' } as never));
    sink.sinkLoopEvent(stamp({ step: 'accept', jobId: 'j1', rating: 'satisfied' } as never));
    sink.sinkHeartbeat({ kind: 'heartbeat', of: 'reputation-write', phase: 'writing', writeState: 'pending', elapsedMs: 3000 });
    await closeAndWait(sink);

    const final = anchors.at(-1);
    // Without it the tail would be attested by nothing: the `slash` anchor's
    // head stops at its own line. The run header takes seq 1, so `slash` is 2,
    // `accept` is 3 and the trailing heartbeat is 4.
    expect(final).toMatchObject({ step: FINAL_ANCHOR_STEP, from: 3, seq: 4 });
    expect(final?.chain).toEqual(replayChain(sinkPath).head);
  });

  it('a single edited byte anywhere in the file breaks the anchored chain', async () => {
    const stamp = createEventStamper();
    const sink = createLoopEventSink(sinkPath, stamp, { onAnchor: (r) => anchors.push(r) });

    sink.sinkLoopEvent(stamp({ step: 'pay', phase: 'paid', name: 'x', txId: 't', amountHbar: 5 }));
    sink.sinkLoopEvent(stamp({ step: 'verify', outcome: 'refuted', jobId: 'j1' } as never));
    await closeAndWait(sink);

    // Rewrite history the way a dishonest operator would: make the payment
    // look larger after the fact. This is the exact attack the anchor exists
    // to catch, so assert on it rather than on a synthetic mutation.
    // Line 0 is the run header, so the payment is line 1.
    const lines = readFileSync(sinkPath, 'utf8').split('\n').filter(Boolean);
    lines[1] = lines[1].replace('"amountHbar":5', '"amountHbar":9');
    expect(lines[1]).toContain('"amountHbar":9');

    let head = ANCHOR_GENESIS;
    const tamperedBySeq = new Map<number, string>();
    for (const line of lines) {
      head = advanceChain(head, line);
      tamperedBySeq.set(seqOf(line), head);
    }
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(tamperedBySeq.get(anchor.seq)).not.toEqual(anchor.chain);
    }
  });

  it('does not anchor a line the write stream never accepted', async () => {
    // The failure mode this guards: `stream.write()` buffers happily and only
    // reports the open failure on its callback a tick later, so a sink that
    // anchored straight after `write()` would commit to a line no verifier
    // can read back -- which reads downstream as tampering rather than as a
    // broken sink. The sink's own `mkdirSync(dirname(path), {recursive:true})`
    // creates any missing directories, so a missing path is not unwritable;
    // pointing it at an existing *directory* is (EISDIR on open).
    const blocked = join(dir, 'is-a-directory');
    mkdirSync(blocked);
    const stamp = createEventStamper();
    const sink = createLoopEventSink(blocked, stamp, { onAnchor: (r) => anchors.push(r) });
    sink.sinkLoopEvent(stamp({ step: 'pay', phase: 'paid', name: 'x', txId: 't', amountHbar: 5 }));
    await closeAndWait(sink);
    expect(anchors).toEqual([]);
  });
});

describe('createLoopAnchor', () => {
  function fakeTopicClient(overrides: Partial<HederaTopicClient> = {}): HederaTopicClient {
    let sequence = 0;
    return {
      createTopic: async () => ({ topicId: '0.0.fake' }),
      submitMessage: async () => ({ txId: `0.0.1@${++sequence}`, sequenceNumber: sequence }),
      close: () => {},
      ...overrides,
    };
  }

  const record = (seq: number, step = 'pay'): LoopAnchorRecord => ({
    v: ANCHOR_VERSION,
    run: 'runidforthetest',
    seq,
    from: seq,
    step,
    chain: `${seq}`.padStart(64, '0'),
  });

  /** Drains the microtask queue. Deterministic where a `setTimeout` would be a guess. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }

  it('submits every queued anchor in order, never two at once', async () => {
    // Order matters because the topic assigns sequence numbers at consensus:
    // two in-flight submits could land either way round and put the anchors on
    // the topic out of chain order. Asserted by gating each submit rather than
    // by racing sleeps -- this proves submit N+1 has not *started* until N
    // returns, which a timing test can only suggest.
    const started: number[] = [];
    const gates: PromiseWithResolvers<void>[] = [];
    const anchor = createLoopAnchor({
      topicId: '0.0.fake',
      client: fakeTopicClient({
        submitMessage: async ({ message }) => {
          started.push(seqOf(message));
          const gate = Promise.withResolvers<void>();
          gates.push(gate);
          await gate.promise;
          return { txId: 't', sequenceNumber: started.length };
        },
      }),
    });

    anchor.anchor(record(0));
    anchor.anchor(record(1));
    anchor.anchor(record(2));

    await settle();
    expect(started).toEqual([0]);
    gates[0].resolve();
    await settle();
    expect(started).toEqual([0, 1]);
    gates[1].resolve();
    await settle();
    expect(started).toEqual([0, 1, 2]);
    gates[2].resolve();

    await expect(anchor.close()).resolves.toEqual({ drained: true });
  });

  it('a failed submit never throws at the caller and stops the anchor for the run', async () => {
    // The sink calls `anchor()` from inside a tool call. A topic outage must
    // cost the run its audit trail, never its payment.
    const onError = vi.fn();
    const submitMessage = vi.fn(async () => {
      throw new Error('CONNECTION_REFUSED');
    });
    const anchor = createLoopAnchor({
      topicId: '0.0.fake',
      client: fakeTopicClient({ submitMessage }),
      onError,
    });

    expect(() => anchor.anchor(record(0))).not.toThrow();
    await anchor.close();
    expect(() => anchor.anchor(record(1))).not.toThrow();
    await anchor.close();

    // A chain with a hole invites a reader to treat a gap as noise, so one
    // failure ends anchoring rather than resuming at the next step.
    expect(submitMessage).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('reports its queue as undrained rather than hanging the exit', async () => {
    vi.useFakeTimers();
    try {
      const anchor = createLoopAnchor({
        topicId: '0.0.fake',
        client: fakeTopicClient({ submitMessage: () => Promise.withResolvers<never>().promise }),
      });
      anchor.anchor(record(0));
      const closing = anchor.close(20_000);
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(closing).resolves.toEqual({ drained: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('narrates the topic sequence number a verifier will look for', async () => {
    const published: number[] = [];
    const anchor = createLoopAnchor({
      topicId: '0.0.fake',
      client: fakeTopicClient(),
      onPublished: ({ sequenceNumber }) => published.push(sequenceNumber),
    });
    anchor.anchor(record(0));
    anchor.anchor(record(1));
    await anchor.close();
    expect(published).toEqual([1, 2]);
  });
});

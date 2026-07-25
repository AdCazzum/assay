import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSinkLine, splitLines, startSinkTailer } from './sink-tailer.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('splitLines', () => {
  it('splits complete lines and holds a partial trailing remainder', () => {
    const { lines, remainder } = splitLines('', 'a\nb\nc');
    expect(lines).toEqual(['a', 'b']);
    expect(remainder).toBe('c');
  });

  it('prepends the held remainder to the next chunk', () => {
    const first = splitLines('', 'part-o');
    expect(first.lines).toEqual([]);
    expect(first.remainder).toBe('part-o');
    const second = splitLines(first.remainder, 'ne\ntwo\n');
    expect(second.lines).toEqual(['part-one', 'two']);
    expect(second.remainder).toBe('');
  });

  it('drops blank lines', () => {
    const { lines } = splitLines('', 'a\n\n\nb\n');
    expect(lines).toEqual(['a', 'b']);
  });
});

describe('parseSinkLine', () => {
  it('recognizes a real LoopEvent line by "step", never "kind"', () => {
    const parsed = parseSinkLine(JSON.stringify({ at: 1, seq: 1, step: 'discover', outcome: 'ok' }));
    expect(parsed.kind).toBe('loop-event');
  });

  it('recognizes a heartbeat line by "kind"', () => {
    const parsed = parseSinkLine(JSON.stringify({ at: 1, seq: 2, kind: 'heartbeat', of: 'reputation-write' }));
    expect(parsed.kind).toBe('heartbeat');
  });

  it('marks unparsable JSON and non-matching shapes as unparsable rather than throwing', () => {
    expect(parseSinkLine('not json').kind).toBe('unparsable');
    expect(parseSinkLine(JSON.stringify({ foo: 'bar' })).kind).toBe('unparsable');
  });
});

describe('startSinkTailer', () => {
  let dir: string;
  let sinkPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'assay-tailer-'));
    sinkPath = path.join(dir, 'events.ndjson');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is a normal pre-run state when the sink file does not exist yet: no onError call', async () => {
    const onLine = vi.fn();
    const onError = vi.fn();
    const handle = startSinkTailer({ path: sinkPath, onLine, onError, intervalMs: 20 });
    await delay(80);
    handle.stop();
    expect(onLine).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('picks up lines written before the tailer starts (no coordination needed)', async () => {
    writeFileSync(sinkPath, '{"a":1}\n{"a":2}\n');
    const onLine = vi.fn();
    const handle = startSinkTailer({ path: sinkPath, onLine, intervalMs: 20 });
    await delay(80);
    handle.stop();
    expect(onLine).toHaveBeenCalledTimes(2);
    expect(onLine).toHaveBeenNthCalledWith(1, '{"a":1}');
    expect(onLine).toHaveBeenNthCalledWith(2, '{"a":2}');
  });

  it('tails lines appended after the tailer starts, in order, exactly once each', async () => {
    writeFileSync(sinkPath, '');
    const onLine = vi.fn();
    const handle = startSinkTailer({ path: sinkPath, onLine, intervalMs: 20 });
    await delay(40);
    appendFileSync(sinkPath, '{"a":1}\n');
    await delay(60);
    appendFileSync(sinkPath, '{"a":2}\n{"a":3}\n');
    await delay(80);
    handle.stop();
    expect(onLine.mock.calls.map((c) => c[0])).toEqual(['{"a":1}', '{"a":2}', '{"a":3}']);
  });

  it('holds a partial trailing line across polls instead of emitting it early', async () => {
    writeFileSync(sinkPath, '{"a":1}\n{"partial"');
    const onLine = vi.fn();
    const handle = startSinkTailer({ path: sinkPath, onLine, intervalMs: 20 });
    await delay(60);
    expect(onLine).toHaveBeenCalledTimes(1);
    appendFileSync(sinkPath, ':true}\n');
    await delay(60);
    handle.stop();
    expect(onLine.mock.calls.map((c) => c[0])).toEqual(['{"a":1}', '{"partial":true}']);
  });

  it('stop() halts further polling', async () => {
    writeFileSync(sinkPath, '');
    const onLine = vi.fn();
    const handle = startSinkTailer({ path: sinkPath, onLine, intervalMs: 20 });
    handle.stop();
    appendFileSync(sinkPath, '{"a":1}\n');
    await delay(80);
    expect(onLine).not.toHaveBeenCalled();
  });
});

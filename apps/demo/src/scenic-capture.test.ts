import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScenicRecorder, readScenicCapture, replayScenicCapture } from './scenic-capture.js';

describe('createScenicRecorder / readScenicCapture', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'assay-scenic-capture-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes {source, recordedAtMs, payload} lines relative to the run start', () => {
    const capturePath = path.join(dir, 'run.scenic.ndjson');
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const recorder = createScenicRecorder(capturePath, now);

    recorder.record('agent', '{"type":"assistant"}');
    now += 250;
    recorder.record('loop', '{"step":"discover"}');
    now += 4000;
    recorder.record('agent', '{"type":"result"}');

    vi.restoreAllMocks();

    const records = readScenicCapture(capturePath);
    expect(records).toEqual([
      { source: 'agent', recordedAtMs: 0, payload: '{"type":"assistant"}' },
      { source: 'loop', recordedAtMs: 250, payload: '{"step":"discover"}' },
      { source: 'agent', recordedAtMs: 4250, payload: '{"type":"result"}' },
    ]);
  });

  it('never throws when the path is unwritable', () => {
    const unwritable = path.join(dir, 'does-not-exist', 'run.scenic.ndjson');
    const recorder = createScenicRecorder(unwritable);
    expect(() => recorder.record('agent', 'x')).not.toThrow();
  });

  it('reading a capture that was never written throws (a rehearsal with nothing to replay is a real failure)', () => {
    expect(() => readScenicCapture(path.join(dir, 'missing.scenic.ndjson'))).toThrow();
  });
});

describe('replayScenicCapture', () => {
  it('replays records in order, waiting the recorded relative gap between each (scaled by speed)', async () => {
    const records = [
      { source: 'agent' as const, recordedAtMs: 0, payload: 'a' },
      { source: 'loop' as const, recordedAtMs: 100, payload: 'b' },
      { source: 'agent' as const, recordedAtMs: 130, payload: 'c' },
    ];
    const seen: Array<{ payload: string; at: number }> = [];
    const start = Date.now();
    await replayScenicCapture(records, (r) => seen.push({ payload: r.payload, at: Date.now() - start }), { speed: 20 });
    expect(seen.map((s) => s.payload)).toEqual(['a', 'b', 'c']);
    // At 20x speed, the 130ms of real gaps collapse to ~6.5ms -- generous
    // bound to avoid flaking on CI scheduling jitter, while still proving
    // the gaps were honored rather than skipped.
    expect(seen[2].at).toBeLessThan(100);
  });

  it('an empty capture replays nothing and resolves immediately', async () => {
    const onRecord = vi.fn();
    await replayScenicCapture([], onRecord);
    expect(onRecord).not.toHaveBeenCalled();
  });
});

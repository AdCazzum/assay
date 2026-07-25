import { describe, expect, it } from 'vitest';
import { createScenicLoopMapper } from './scenic-loop-mapper.js';
import { parseSinkLine } from './sink-tailer.js';

describe('createScenicLoopMapper', () => {
  it('maps a real LoopEvent line through the same @assay/dashboard mapping the live in-process demo used', () => {
    const mapper = createScenicLoopMapper();
    const parsed = parseSinkLine(
      JSON.stringify({ at: 1, seq: 1, step: 'discover', outcome: 'ok', name: 'rugscore.assay.eth', provider: { manifest: { priceHbar: 5 }, reputation: { score: 78, jobs: 14, slashes: 0, bondHbar: 30 } } }),
    );
    const result = mapper(parsed);
    expect(result.isRealLoopEvent).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].step).toBe('discover');
    expect(result.events[0].status).toBe('ok');
  });

  it('maps a reputation-write heartbeat line into the same formatReputationHeartbeat() shape the in-process demo already used', () => {
    const mapper = createScenicLoopMapper();
    const parsed = parseSinkLine(
      JSON.stringify({ at: 1, seq: 2, kind: 'heartbeat', of: 'reputation-write', phase: 'writing', writeState: 'pending', elapsedMs: 3000 }),
    );
    const result = mapper(parsed);
    expect(result.isRealLoopEvent).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].step).toBe('reputation');
    expect(result.events[0].summary).toContain('still mining');
  });

  it('a "done" reputation-write heartbeat renders nothing (the terminal LoopEvent already covers it)', () => {
    const mapper = createScenicLoopMapper();
    const parsed = parseSinkLine(
      JSON.stringify({ at: 1, seq: 3, kind: 'heartbeat', of: 'reputation-write', phase: 'done', elapsedMs: 12000, txHash: '0xabc' }),
    );
    expect(mapper(parsed).events).toEqual([]);
  });

  it('a payment-confirm heartbeat produces no dashboard row (core already narrates pay confirming/confirmed)', () => {
    const mapper = createScenicLoopMapper();
    const parsed = parseSinkLine(
      JSON.stringify({ at: 1, seq: 4, kind: 'heartbeat', of: 'payment-confirm', attempt: 1, elapsedMs: 500, state: 'pending' }),
    );
    const result = mapper(parsed);
    expect(result.events).toEqual([]);
    expect(result.isRealLoopEvent).toBe(false);
  });

  it('an unparsable line maps to nothing, never throws', () => {
    const mapper = createScenicLoopMapper();
    expect(() => mapper(parseSinkLine('not json'))).not.toThrow();
    expect(mapper(parseSinkLine('not json')).events).toEqual([]);
  });
});

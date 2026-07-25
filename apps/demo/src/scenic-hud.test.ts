import { describe, expect, it } from 'vitest';
import { isLoopStreamStale, renderHud } from './scenic-hud.js';

describe('renderHud', () => {
  it('shows "none yet" before any loop event has arrived', () => {
    const hud = renderHud({ elapsedMs: 3000, replay: false, runLabel: 'abc123' });
    expect(hud).toContain('loop-events: none yet');
    expect(hud).toContain('elapsed 00:03');
    expect(hud).toContain('ASSAY — scenic run abc123');
  });

  it('shows a fresh "<1s ago" under the stale threshold', () => {
    const hud = renderHud({ elapsedMs: 5000, loopLastEventAgoMs: 400, replay: false, runLabel: 'x' });
    expect(hud).toContain('loop-events: <1s ago');
    expect(hud).not.toContain('stale');
  });

  it('formats elapsed minutes:seconds correctly past 60s', () => {
    const hud = renderHud({ elapsedMs: 125_000, replay: false, runLabel: 'x' });
    expect(hud).toContain('elapsed 02:05');
  });

  it('degrades to a stale warning once past the threshold', () => {
    const hud = renderHud({ elapsedMs: 30_000, loopLastEventAgoMs: 19_000, replay: false, runLabel: 'x', staleThresholdMs: 15_000 });
    expect(hud).toContain('⚠');
    expect(hud).toContain('stale');
    expect(hud).toContain('19s ago');
  });

  it('declares a replay explicitly, never leaving it ambiguous', () => {
    const hud = renderHud({ elapsedMs: 1000, replay: true, runLabel: 'captured-run' });
    expect(hud).toContain('REPLAY');
    expect(hud).toContain('offline rehearsal');
  });
});

describe('isLoopStreamStale', () => {
  it('is false when no event has arrived yet (that is "none yet", not "stale")', () => {
    expect(isLoopStreamStale(undefined)).toBe(false);
  });

  it('is false under the threshold and true over it', () => {
    expect(isLoopStreamStale(14_999, 15_000)).toBe(false);
    expect(isLoopStreamStale(15_001, 15_000)).toBe(true);
  });
});

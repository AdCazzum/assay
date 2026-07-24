import { describe, expect, it } from 'vitest';
import { DEFAULT_RUGSCORE_TOLERANCES, withinTolerance } from './tolerances.js';

describe('withinTolerance', () => {
  it('matches an exact value', () => {
    expect(withinTolerance(100, 100, { absolute: 0, relative: 0 })).toBe(true);
  });

  it('accepts a difference within the absolute tolerance', () => {
    expect(withinTolerance(100.005, 100, { absolute: 0.01, relative: 0 })).toBe(true);
  });

  it('rejects a difference past the absolute tolerance', () => {
    expect(withinTolerance(100.02, 100, { absolute: 0.01, relative: 0 })).toBe(false);
  });

  it('accepts a difference within the relative tolerance for large magnitudes', () => {
    // 0.05% of 1,000,000 is 500: a claim off by 400 should still pass.
    expect(withinTolerance(1_000_400, 1_000_000, { absolute: 0.01, relative: 0.0005 })).toBe(true);
  });

  it('rejects a difference past the relative tolerance for large magnitudes', () => {
    expect(withinTolerance(1_000_600, 1_000_000, { absolute: 0.01, relative: 0.0005 })).toBe(false);
  });

  it('treats NaN on both sides as a match ("not observed" agrees with "not observed")', () => {
    expect(withinTolerance(NaN, NaN, { absolute: 0, relative: 0 })).toBe(true);
  });

  it('treats a claimed NaN against a real derived number as a mismatch', () => {
    expect(withinTolerance(NaN, 42, { absolute: 0, relative: 0 })).toBe(false);
  });

  it('treats a claimed real number against a derived NaN as a mismatch', () => {
    expect(withinTolerance(42, NaN, { absolute: 0, relative: 0 })).toBe(false);
  });

  it('exposes a default tolerance for every RugScoreSignals field', () => {
    expect(Object.keys(DEFAULT_RUGSCORE_TOLERANCES).sort()).toEqual(
      ['liquidityUsd', 'ageBlocks', 'txCount', 'volumeUsd', 'topPoolConcentrationPct'].sort(),
    );
  });

  it('uses exact-match defaults (no tolerance) for the two integer counters', () => {
    // ageBlocks and txCount are exact integer facts derived from immutable
    // historical data (a block delta, a count) at a pinned block: re-querying
    // the same historical block must reproduce them bit-for-bit, so any
    // slack here would just be a hole a liar can hide a real lie in.
    expect(DEFAULT_RUGSCORE_TOLERANCES.ageBlocks).toEqual({ absolute: 0, relative: 0 });
    expect(DEFAULT_RUGSCORE_TOLERANCES.txCount).toEqual({ absolute: 0, relative: 0 });
  });
});

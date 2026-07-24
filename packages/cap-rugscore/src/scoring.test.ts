import { describe, expect, it } from 'vitest';
import { CLEAN_TOKEN_SIGNALS, RUG_TOKEN_SIGNALS } from './fixtures.js';
import { scoreRugPullRisk } from './scoring.js';

describe('scoreRugPullRisk (pure)', () => {
  it('scores a clean token low', () => {
    const { score } = scoreRugPullRisk(CLEAN_TOKEN_SIGNALS);
    expect(score).toBeLessThan(30);
  });

  it('scores a rug token high', () => {
    const { score } = scoreRugPullRisk(RUG_TOKEN_SIGNALS);
    expect(score).toBeGreaterThan(70);
  });

  it('keeps the score within 0..100', () => {
    const { score: clean } = scoreRugPullRisk(CLEAN_TOKEN_SIGNALS);
    const { score: rug } = scoreRugPullRisk(RUG_TOKEN_SIGNALS);
    for (const score of [clean, rug]) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it('returns exactly the five claim keys backed by real TokenSignals fields, carrying the input values', () => {
    const { claims } = scoreRugPullRisk(RUG_TOKEN_SIGNALS);
    expect(claims).toEqual([
      { k: 'liquidityUsd', v: RUG_TOKEN_SIGNALS.liquidityUsd },
      { k: 'ageBlocks', v: RUG_TOKEN_SIGNALS.ageBlocks },
      { k: 'txCount', v: RUG_TOKEN_SIGNALS.txCount },
      { k: 'volumeUsd', v: RUG_TOKEN_SIGNALS.volumeUsd },
      { k: 'topPoolConcentrationPct', v: RUG_TOKEN_SIGNALS.topPoolConcentrationPct },
    ]);
  });

  it('is monotonic: thinner liquidity alone never lowers the score', () => {
    const liquid = scoreRugPullRisk({ ...CLEAN_TOKEN_SIGNALS, liquidityUsd: 1_000_000 });
    const illiquid = scoreRugPullRisk({ ...CLEAN_TOKEN_SIGNALS, liquidityUsd: 500 });
    expect(illiquid.score).toBeGreaterThan(liquid.score);
  });

  it('is monotonic: a younger token alone never lowers the score', () => {
    const old = scoreRugPullRisk({ ...CLEAN_TOKEN_SIGNALS, ageBlocks: 1_000_000 });
    const young = scoreRugPullRisk({ ...CLEAN_TOKEN_SIGNALS, ageBlocks: 10 });
    expect(young.score).toBeGreaterThan(old.score);
  });

  it('is monotonic: a lower txCount alone never lowers the score', () => {
    const active = scoreRugPullRisk({ ...CLEAN_TOKEN_SIGNALS, txCount: 1_000_000 });
    const inactive = scoreRugPullRisk({ ...CLEAN_TOKEN_SIGNALS, txCount: 3 });
    expect(inactive.score).toBeGreaterThan(active.score);
  });

  it('is monotonic: lower cumulative volume alone never lowers the score', () => {
    const traded = scoreRugPullRisk({ ...CLEAN_TOKEN_SIGNALS, volumeUsd: 10_000_000 });
    const untraded = scoreRugPullRisk({ ...CLEAN_TOKEN_SIGNALS, volumeUsd: 0 });
    expect(untraded.score).toBeGreaterThan(traded.score);
  });

  it('is monotonic: higher top-pool concentration alone never lowers the score', () => {
    const spread = scoreRugPullRisk({ ...CLEAN_TOKEN_SIGNALS, topPoolConcentrationPct: 20 });
    const concentrated = scoreRugPullRisk({ ...CLEAN_TOKEN_SIGNALS, topPoolConcentrationPct: 100 });
    expect(concentrated.score).toBeGreaterThan(spread.score);
  });

  it('treats an unobserved liquidity/age/concentration signal (NaN — no pool existed yet) as maximally risky, not zero risk', () => {
    const neverTraded = scoreRugPullRisk({
      ...CLEAN_TOKEN_SIGNALS,
      liquidityUsd: NaN,
      ageBlocks: NaN,
      topPoolConcentrationPct: NaN,
    });
    // liquidityUsd (30) + ageBlocks (20) + topPoolConcentrationPct (20) all
    // max out their weight when unobserved; txCount/volumeUsd are untouched
    // (still clean, contributing 0), so this is the ceiling for this mix,
    // not full 100 — but still nowhere near a "no risk" reading.
    expect(neverTraded.score).toBe(70);
  });

  it('is pure: same input always yields the same output', () => {
    const a = scoreRugPullRisk(RUG_TOKEN_SIGNALS);
    const b = scoreRugPullRisk(RUG_TOKEN_SIGNALS);
    expect(a).toEqual(b);
  });
});

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

  it('returns exactly the four claim keys required by SPEC.md §6, carrying the input values', () => {
    const { claims } = scoreRugPullRisk(RUG_TOKEN_SIGNALS);
    expect(claims).toEqual([
      { k: 'top10Pct', v: RUG_TOKEN_SIGNALS.top10Pct },
      { k: 'liquidityUsd', v: RUG_TOKEN_SIGNALS.liquidityUsd },
      { k: 'ageBlocks', v: RUG_TOKEN_SIGNALS.ageBlocks },
      { k: 'hasActiveMintRole', v: RUG_TOKEN_SIGNALS.hasActiveMintRole },
    ]);
  });

  it('is monotonic: higher top10 concentration alone never lowers the score', () => {
    const base = scoreRugPullRisk({ ...CLEAN_TOKEN_SIGNALS, top10Pct: 10 });
    const concentrated = scoreRugPullRisk({ ...CLEAN_TOKEN_SIGNALS, top10Pct: 90 });
    expect(concentrated.score).toBeGreaterThan(base.score);
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

  it('an active mint role alone adds risk, all else equal', () => {
    const withoutMint = scoreRugPullRisk({ ...CLEAN_TOKEN_SIGNALS, hasActiveMintRole: false });
    const withMint = scoreRugPullRisk({ ...CLEAN_TOKEN_SIGNALS, hasActiveMintRole: true });
    expect(withMint.score).toBeGreaterThan(withoutMint.score);
  });

  it('is pure: same input always yields the same output', () => {
    const a = scoreRugPullRisk(RUG_TOKEN_SIGNALS);
    const b = scoreRugPullRisk(RUG_TOKEN_SIGNALS);
    expect(a).toEqual(b);
  });
});

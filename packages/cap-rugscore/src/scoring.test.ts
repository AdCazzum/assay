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

  describe('GOODCAT (real mainnet token, TESTING.md Level 3) drifts by design as it ages', () => {
    // GOODCAT's other signals as live-verified for #49 (see TESTING.md and
    // packages/graph/README.md): $56.51 in its one pool, 2 txs, 100%
    // concentration, negligible cumulative volume. ageBlocks is
    // `currentBlock - createdAtBlockNumber`, recomputed live on every query,
    // so it only ever grows; this is what makes the score itself time-varying
    // rather than a fixed fixture, unlike CLEAN/RUG_TOKEN_SIGNALS above.
    const goodcatAt = (ageBlocks: number) =>
      scoreRugPullRisk({
        liquidityUsd: 56.51,
        ageBlocks,
        txCount: 2,
        volumeUsd: 57,
        topPoolConcentrationPct: 100,
      });

    it('scored a full 100 at the age TESTING.md\'s reference table was captured at (3,259 blocks)', () => {
      expect(goodcatAt(3_259).score).toBe(100);
    });

    it('had already rounded down to 99 an hour or so later (~6,900 blocks), and TESTING.md must not promise an exact 100', () => {
      expect(goodcatAt(6_900).score).toBe(99);
    });

    it('never recovers: the score is monotonically non-increasing as GOODCAT keeps aging', () => {
      const ages = [3_259, 6_900, 20_000, 100_000, 199_999];
      const scores = ages.map((age) => goodcatAt(age).score);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
      }
      // Confirms the drift is a real, if small, safety credit approaching
      // MATURE_AGE_BLOCKS, not just rounding noise around 100.
      expect(scores.at(-1)).toBeLessThan(scores[0]);
    });
  });
});

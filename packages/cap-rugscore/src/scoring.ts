import type { TokenSignals } from '@assay/core';

/**
 * The rug-pull scoring logic, kept pure and separately testable from the
 * fetching (see `rugscore.ts`). This is the seam the verifier in #12 relies
 * on: it re-derives the same signals from The Graph and must be able to feed
 * them through the exact same judgment to compare against a provider's
 * claims, with no I/O in the way.
 *
 * Takes every field `@assay/graph` can genuinely source at a pinned block
 * (see its README for how each was verified live). #49 rebuilt this set
 * after #42 left four of six original `TokenSignals` fields unimplemented
 * (`holders`, `top10Pct`, `transfers`, `hasActiveMintRole`) — see
 * `packages/core/src/ports.ts` for why those were deleted rather than kept
 * as sentinels.
 */
export type RugScoreSignals = Pick<
  TokenSignals,
  'liquidityUsd' | 'ageBlocks' | 'txCount' | 'volumeUsd' | 'topPoolConcentrationPct'
>;

/** An unstamped claim: `{k, v}` without `atBlock`, which the caller stamps. */
export type UnstampedClaim = { k: string; v: unknown };

export type ScoreResult = {
  score: number;
  claims: UnstampedClaim[];
};

// Weight each signal contributes to the 0..100 risk score. They sum to 100 so
// "everything about this token looks maximally risky" caps at exactly 100.
const LIQUIDITY_WEIGHT = 30;
const AGE_WEIGHT = 20;
const CONCENTRATION_WEIGHT = 20;
const TX_COUNT_WEIGHT = 15;
const VOLUME_WEIGHT = 15;

// Liquidity (the deepest single pool's TVL) at or above this floor is
// treated as fully safe on that signal; below it, risk scales up linearly to
// the floor. A real, thin/sketchy token measured live for this issue held
// $56 in its only pool; a real blue chip (USDC) held $400M+ in its deepest
// pool alone — the floor sits far below the latter and far above the former.
const LIQUIDITY_SAFE_FLOOR_USD = 50_000;

// Age at or above this many blocks is treated as fully mature (fully safe on
// that signal); younger tokens scale up to full risk as age approaches zero.
const MATURE_AGE_BLOCKS = 200_000;

// Uniswap v3 swap/mint/burn count at or above this is treated as fully
// mature activity; a live-verified thin token held txCount in the single
// digits to low hundreds, against USDC's tens of millions.
const ACTIVE_TX_COUNT_FLOOR = 100_000;

// Cumulative tracked volume at or above this is treated as fully safe; a
// live-verified thin token held single-digit-to-low-hundreds USD lifetime
// volume, against USDC's hundreds of billions.
const ACTIVE_VOLUME_SAFE_FLOOR_USD = 1_000_000;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Risk contribution for a "more is safer, up to a floor" signal: at or above
 * `floor`, risk is 0; below it, risk scales linearly to `weight` as the value
 * approaches 0. `NaN` (the signal was never observed — no pool existed yet
 * as of this block) is treated as maximally risky, same as `value <= 0`:
 * "we cannot observe any liquidity/activity for this token yet" is not a
 * safer claim than "we observed none."
 */
function riskAboveFloor(value: number, floor: number, weight: number): number {
  if (Number.isNaN(value)) return weight;
  return clamp01(1 - value / floor) * weight;
}

/**
 * Aggregates token signals into a rug-pull risk score (0..100, higher is
 * riskier) plus the factual claims backing it. Pure: no network, no clock, no
 * `atBlock` — the caller (`rugscore.ts`) stamps every claim with the block
 * the signals actually came from.
 */
export function scoreRugPullRisk(signals: RugScoreSignals): ScoreResult {
  const liquidityRisk = riskAboveFloor(signals.liquidityUsd, LIQUIDITY_SAFE_FLOOR_USD, LIQUIDITY_WEIGHT);
  const ageRisk = riskAboveFloor(signals.ageBlocks, MATURE_AGE_BLOCKS, AGE_WEIGHT);
  const txCountRisk = riskAboveFloor(signals.txCount, ACTIVE_TX_COUNT_FLOOR, TX_COUNT_WEIGHT);
  const volumeRisk = riskAboveFloor(signals.volumeUsd, ACTIVE_VOLUME_SAFE_FLOOR_USD, VOLUME_WEIGHT);
  // Concentration is "more is riskier" (the opposite direction from the
  // signals above), and NaN (no pool observed yet) is maximally risky here
  // too, for the same reason: no observable venue is not a safer claim than
  // one fully concentrated pool.
  const concentrationRisk = Number.isNaN(signals.topPoolConcentrationPct)
    ? CONCENTRATION_WEIGHT
    : clamp01(signals.topPoolConcentrationPct / 100) * CONCENTRATION_WEIGHT;

  const rawScore = liquidityRisk + ageRisk + concentrationRisk + txCountRisk + volumeRisk;
  const score = Math.round(clamp01(rawScore / 100) * 100);

  return {
    score,
    claims: [
      { k: 'liquidityUsd', v: signals.liquidityUsd },
      { k: 'ageBlocks', v: signals.ageBlocks },
      { k: 'txCount', v: signals.txCount },
      { k: 'volumeUsd', v: signals.volumeUsd },
      { k: 'topPoolConcentrationPct', v: signals.topPoolConcentrationPct },
    ],
  };
}

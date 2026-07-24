import type { TokenSignals } from '@assay/core';

/**
 * The rug-pull scoring logic, kept pure and separately testable from the
 * fetching (see `rugscore.ts`). This is the seam the verifier in #12 relies
 * on: it re-derives the same four signals from The Graph and must be able to
 * feed them through the exact same judgment to compare against a provider's
 * claims, with no I/O in the way.
 *
 * Deliberately takes only the four signals SPEC.md §6 lists as claims
 * (`top10Pct`, `liquidityUsd`, `ageBlocks`, `hasActiveMintRole`), not the full
 * `TokenSignals` shape, so it is obvious which fields the score actually
 * depends on.
 */
export type RugScoreSignals = Pick<
  TokenSignals,
  'top10Pct' | 'liquidityUsd' | 'ageBlocks' | 'hasActiveMintRole'
>;

/** An unstamped claim: `{k, v}` without `atBlock`, which the caller stamps. */
export type UnstampedClaim = { k: string; v: unknown };

export type ScoreResult = {
  score: number;
  claims: UnstampedClaim[];
};

// Weight each signal contributes to the 0..100 risk score. They sum to 100 so
// "everything about this token looks maximally risky" caps at exactly 100.
const TOP10_CONCENTRATION_WEIGHT = 40;
const LIQUIDITY_WEIGHT = 30;
const AGE_WEIGHT = 20;
const ACTIVE_MINT_ROLE_WEIGHT = 10;

// Liquidity at or above this floor is treated as fully safe on that signal;
// below it, risk scales up linearly to the floor.
const LIQUIDITY_SAFE_FLOOR_USD = 50_000;

// Age at or above this many blocks is treated as fully mature (fully safe on
// that signal); younger tokens scale up to full risk as age approaches zero.
const MATURE_AGE_BLOCKS = 200_000;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Aggregates token signals into a rug-pull risk score (0..100, higher is
 * riskier) plus the factual claims backing it. Pure: no network, no clock, no
 * `atBlock` — the caller (`rugscore.ts`) stamps every claim with the block
 * the signals actually came from.
 */
export function scoreRugPullRisk(signals: RugScoreSignals): ScoreResult {
  const concentrationRisk = clamp01(signals.top10Pct / 100) * TOP10_CONCENTRATION_WEIGHT;
  const liquidityRisk =
    clamp01(1 - signals.liquidityUsd / LIQUIDITY_SAFE_FLOOR_USD) * LIQUIDITY_WEIGHT;
  const ageRisk = clamp01(1 - signals.ageBlocks / MATURE_AGE_BLOCKS) * AGE_WEIGHT;
  const mintRisk = signals.hasActiveMintRole ? ACTIVE_MINT_ROLE_WEIGHT : 0;

  const rawScore = concentrationRisk + liquidityRisk + ageRisk + mintRisk;
  const score = Math.round(clamp01(rawScore / 100) * 100);

  return {
    score,
    claims: [
      { k: 'top10Pct', v: signals.top10Pct },
      { k: 'liquidityUsd', v: signals.liquidityUsd },
      { k: 'ageBlocks', v: signals.ageBlocks },
      { k: 'hasActiveMintRole', v: signals.hasActiveMintRole },
    ],
  };
}

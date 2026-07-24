import type { RugScoreSignals } from './scoring.js';

/**
 * How much a re-derived value is allowed to differ from a claimed value
 * before `verify()` calls it a lie. Two knobs, combined with "whichever
 * allows more":
 *
 * - `absolute` — a flat allowance in the signal's own units, dominant near
 *   zero (where a relative tolerance would allow almost nothing).
 * - `relative` — a fraction of the re-derived value's own magnitude,
 *   dominant for large values (where a fixed absolute allowance would either
 *   be too tight to survive real noise, or so loose it hides a real lie).
 *
 * `0`/`0` means exact match required.
 */
export type NumericTolerance = {
  absolute: number;
  relative: number;
};

export type RugScoreTolerances = Record<keyof RugScoreSignals, NumericTolerance>;

/**
 * Default per-signal tolerances `verify()` uses to re-derive and compare each
 * claim (SPEC.md §12). Each one is a real design decision, justified below,
 * and every one is overridable per-deps (see `RugScoreDeps.tolerances` in
 * `rugscore.ts`) without touching this file.
 */
export const DEFAULT_RUGSCORE_TOLERANCES: RugScoreTolerances = {
  // USD, from the subgraph's BigDecimal string. Re-querying the exact same
  // historical block should reproduce the same figure, but BigDecimal ->
  // JS number parsing and summation order can differ in the last digits
  // between two runs of the same query, and neither side of that gap is
  // the "true" one. $0.01 absolute covers that noise even for the
  // thinnest real pool this project measured (GOODCAT: $56.51 total); 0.05%
  // relative covers it for a blue-chip token (USDC: $400M+) without hiding a
  // liar's misreport of a material fraction of real liquidity (0.05% of a
  // multi-million dollar pool is still hundreds of dollars, far below a
  // rug-score-relevant lie).
  liquidityUsd: { absolute: 0.01, relative: 0.0005 },
  // Blocks. `atBlock - createdAtBlockNumber` of an immutable historical
  // pool-creation event: both operands are fixed once the chain has passed
  // that block, so re-deriving it at the same `atBlock` must reproduce the
  // exact same integer. Any tolerance here is a hole a liar can hide a real
  // lie about token age in.
  ageBlocks: { absolute: 0, relative: 0 },
  // A count of immutable historical events (swaps/mints/burns) as of a
  // pinned block. Same reasoning as `ageBlocks`: exact, deterministic,
  // no honest source of noise to tolerate.
  txCount: { absolute: 0, relative: 0 },
  // USD, cumulative volume from the same BigDecimal source as
  // `liquidityUsd`, so it gets the same combined absolute+relative
  // allowance for the same reason.
  volumeUsd: { absolute: 0.01, relative: 0.0005 },
  // A percentage (0..100) already normalized by the adapter (one pool's TVL
  // over a small sampled group's total), so an absolute tolerance in
  // percentage-points is the meaningful unit, not a relative one: 0.01
  // points survives float-division noise (e.g. summing 5 pool TVLs in a
  // different order) while still catching a liar who reports, say, 60%
  // concentration when the real figure is 98%.
  topPoolConcentrationPct: { absolute: 0.01, relative: 0 },
};

/**
 * Compares a claimed value against the value re-derived from the source of
 * truth, within `tolerance`. `NaN` is a legitimate value (SPEC.md §12: "no
 * pool observed at that block"), so it gets its own rule rather than falling
 * into the arithmetic below (where `NaN - NaN` and any comparison against
 * `NaN` is always `false` in JS, which would silently read as "mismatch" for
 * the one case that is actually the strongest possible agreement between the
 * two sides): both `NaN` is a match (both sides agree nothing was observed);
 * exactly one `NaN` is a real mismatch (one side claims an observation the
 * other doesn't have, or vice versa).
 */
export function withinTolerance(claimed: number, actual: number, tolerance: NumericTolerance): boolean {
  const claimedIsNaN = Number.isNaN(claimed);
  const actualIsNaN = Number.isNaN(actual);
  if (claimedIsNaN || actualIsNaN) {
    return claimedIsNaN && actualIsNaN;
  }
  const allowed = Math.max(tolerance.absolute, Math.abs(actual) * tolerance.relative);
  return Math.abs(claimed - actual) <= allowed;
}

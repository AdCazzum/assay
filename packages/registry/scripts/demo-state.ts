/**
 * Pure logic for the demo's opening reputation state (issue #64: "the live
 * ENS reputation is now too damaged for the demo's opening act").
 *
 * Split out from `reset-demo-state.ts` deliberately so it can be unit-tested
 * without touching Sepolia or Hedera: `reset-demo-state.ts` (like this
 * package's `smoke.ts`/`smoke-reputation.ts`) calls its `main()`
 * unconditionally at module load, so importing that file anywhere -- a test
 * included -- would fire live network calls. This file has no I/O, no clock,
 * no adapter: same `priceHbar` in, same `Reputation` out, every time.
 */

import type { Reputation } from '@assay/core';

/**
 * Chosen deliberately, justified in the PR for issue #64:
 *
 * - `score: 78` reads as a genuinely good provider without hitting the 0-100
 *   ceiling, which would look invented rather than earned.
 * - `jobs: 14` is well past `assessProvider`'s "unproven" cutoff
 *   (`jobs === 0`, see `@assay/core`'s `assessment.ts`): an established
 *   provider with a real track record, not a freshly registered one.
 * - `slashes: 0` -- a clean record. `assessTrackRecord` reports this as an
 *   `info`-severity "Clean record" signal, not a caution or a concern.
 */
export const DEMO_SCORE = 78;
export const DEMO_JOBS = 14;
export const DEMO_SLASHES = 0;

/**
 * `bondHbar` is written as this many multiples of the manifest's *live*
 * `priceHbar`, never a hardcoded absolute HBAR figure -- whatever the
 * provider's published price actually is, the bond stays a genuine multiple
 * of it (see `computeDemoBondHbar`). 6x clears `@assay/core`'s
 * `DEFAULT_PAY_DECISION_POLICY.minBondToPriceRatio` (2) with a comfortable
 * margin and lands past `assessment.ts`'s own `ADEQUATE_BOND_RATIO` (5) into
 * its "strong collateral" band. That is the exact signal issue #64 calls
 * out: 0.02 HBAR against a 5 HBAR price (0.004x) reads as "a bond smaller
 * than the fee is no deterrent at all", and the agent was right to decline
 * on it.
 */
export const DEFAULT_DEMO_BOND_MULTIPLE = 6;

/**
 * `priceHbar * multiple`, rounded to 2 decimal places -- HBAR's practical
 * display precision here, and it avoids float noise like
 * `29.999999999999996` leaking into a value that gets JSON-encoded straight
 * onto a public ENS record.
 */
export function computeDemoBondHbar(priceHbar: number, multiple: number = DEFAULT_DEMO_BOND_MULTIPLE): number {
  return Math.round(priceHbar * multiple * 100) / 100;
}

/**
 * The sacrificial provider (`liar.<parent>`, the one `apps/watchdog` slashes)
 * needs resetting too, and for a different reason than the good one.
 *
 * Found during the first full rehearsal: the watchdog had driven it to
 * `score: 0`, and a score already at the floor cannot visibly drop. The next
 * run would have narrated "score 0 -> 0" at the exact moment the demo is
 * supposed to show reputation collapsing, which is the climax. The reputation
 * write would still have been real, so nothing would have looked broken, and
 * the most important beat in the demo would simply have been invisible.
 *
 * `SETTLEMENT_SCORE_PENALTY` in `@assay/core`'s `settlement-policy.ts` is -30,
 * so this starts high enough that a slash produces a large, legible fall and
 * clamping at 0 never comes into it. Slashes start at 1 rather than 0: this
 * provider is meant to read as one with a history, which is also why the
 * watchdog challenging it is plausible rather than arbitrary.
 */
export const SACRIFICIAL_SCORE = 88;
export const SACRIFICIAL_JOBS = 9;
export const SACRIFICIAL_SLASHES = 1;

/**
 * Opening state for the provider that gets slashed during rehearsals. Bond is
 * a multiple of price for the same reason as the good provider: a bond smaller
 * than the fee is no deterrent, and there is nothing meaningful to slash.
 */
export function buildSacrificialReputation(
  priceHbar: number,
  multiple: number = DEFAULT_DEMO_BOND_MULTIPLE,
): Reputation {
  return {
    score: SACRIFICIAL_SCORE,
    jobs: SACRIFICIAL_JOBS,
    slashes: SACRIFICIAL_SLASHES,
    bondHbar: computeDemoBondHbar(priceHbar, multiple),
  };
}

/**
 * The full, absolute reputation state `reset-demo-state.ts` writes -- not a
 * delta layered on top of whatever is live. `updateReputation`'s
 * read-modify-write (`@assay/registry`'s `ens-registry.ts`) merges its
 * `delta` argument onto the existing record field-by-field, so supplying
 * every field here (as this function does) is what makes the reset actually
 * reset regardless of what the live record currently holds -- including real
 * slashes accumulated by rehearsals, which is the whole reason this script
 * exists.
 */
export function buildDemoReputation(priceHbar: number, multiple: number = DEFAULT_DEMO_BOND_MULTIPLE): Reputation {
  return {
    score: DEMO_SCORE,
    jobs: DEMO_JOBS,
    slashes: DEMO_SLASHES,
    bondHbar: computeDemoBondHbar(priceHbar, multiple),
  };
}

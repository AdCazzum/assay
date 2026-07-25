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

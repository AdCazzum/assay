/**
 * @assay/cap-rugscore — the rug-pull risk scoring capability. See SPEC.md §6.
 *
 * `run()` (issue #11) and `verify()` (issue #12) are both implemented here;
 * see `rugscore.ts`. `verify()` re-derives each claim from `GraphPort` at
 * the claim's own `atBlock` (never the current head) and compares within
 * per-signal tolerances (`tolerances.ts`), throwing
 * `ClaimVerificationUnavailableError` when a claim cannot be judged at all
 * rather than folding "cannot verify" into either verdict (SPEC.md §12).
 */

export const PACKAGE_ID = '@assay/cap-rugscore';

export { createRugScoreCapability } from './rugscore.js';
export type { RugScoreDeps, RugScoreRequest, RugScoreResult } from './rugscore.js';
export { scoreRugPullRisk } from './scoring.js';
export type { RugScoreSignals, ScoreResult, UnstampedClaim } from './scoring.js';
export { CLEAN_TOKEN_SIGNALS, RUG_TOKEN_SIGNALS } from './fixtures.js';
export type { FixtureSignals } from './fixtures.js';
export { DEFAULT_RUGSCORE_TOLERANCES, withinTolerance } from './tolerances.js';
export type { NumericTolerance, RugScoreTolerances } from './tolerances.js';
export { ClaimVerificationUnavailableError } from './errors.js';

/**
 * The manifest's `verifierHash` (SPEC.md §5): a real commitment to the code
 * that adjudicates a challenge, so a provider cannot publish a strict verifier,
 * take payment, then relax it.
 */
export { computeVerifierHash, VERIFIER_SOURCE_FILES } from './verifier-hash.js';

/**
 * Re-exported test harness (SPEC.md §11: declared honestly, never mistaken
 * for `createRugScoreCapability`). `apps/watchdog` (#28) and the demo import
 * it from here rather than reaching into `test-support/` directly.
 */
export { createLyingRugScoreProvider } from './test-support/lying-provider.js';
export type { LyingRugScoreOptions } from './test-support/lying-provider.js';

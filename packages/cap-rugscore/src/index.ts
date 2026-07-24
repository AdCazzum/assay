/**
 * @assay/cap-rugscore — the rug-pull risk scoring capability. See SPEC.md §6.
 *
 * `run()` (issue #11) is implemented here. `verify()` (issue #12) currently
 * throws rather than faking a verdict; see `rugscore.ts`.
 */

export const PACKAGE_ID = '@assay/cap-rugscore';

export { createRugScoreCapability } from './rugscore.js';
export type { RugScoreDeps, RugScoreRequest, RugScoreResult } from './rugscore.js';
export { scoreRugPullRisk } from './scoring.js';
export type { RugScoreSignals, ScoreResult, UnstampedClaim } from './scoring.js';
export { CLEAN_TOKEN_SIGNALS, RUG_TOKEN_SIGNALS } from './fixtures.js';
export type { FixtureSignals } from './fixtures.js';

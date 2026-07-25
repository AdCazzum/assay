/**
 * Token/claim constants shared by `scripts/capture-fixtures.ts` (regenerating
 * `@assay/dashboard`'s fixtures from a real run, issue #85 — kept exactly as
 * reusable across #93/#94's replacement of the keypress runner, per that
 * issue's own "keep the fixture capture" instruction). Split out from the
 * now-deleted `session.ts` (the keypress-era step machine these constants
 * used to default to) so this file's only remaining consumer, the capture
 * script, does not have to import from code that no longer exists.
 */

/** The USDC token the earlier, single-provider agent prompt asked the good provider about (packages/graph/README.md: already verified live). */
export const DEFAULT_REQUEST_TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
/** GOODCAT: the thin, real mainnet token `apps/watchdog` and the current `apps/mcp/agent/prompt.md` mission both use as the challenge target — verified live to score high-risk. */
export const DEFAULT_LIAR_TOKEN = '0xd6c68bc8c862722e140e7b339ddf8a144a7d3530';
export const DEFAULT_CLAIM_KEY = 'liquidityUsd';
/** Comfortably above `DEFAULT_PAY_DECISION_POLICY.minBondToPriceRatio` for any published `priceHbar`; matches `apps/watchdog`'s own default. */
export const DEFAULT_CHALLENGE_BOND_HBAR = 20;

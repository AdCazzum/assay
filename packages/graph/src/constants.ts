/**
 * Fixed, public configuration for the subgraph adapter. See README.md for how
 * this subgraph was chosen and verified, and for the block-out-of-range
 * behaviour `UNISWAP_V3_MAINNET_START_BLOCK` documents.
 */

/**
 * Uniswap v3 mainnet subgraph, served through The Graph's decentralized
 * gateway (`https://gateway.thegraph.com/api/<key>/subgraphs/id/<id>`).
 * Verified live against our own Studio key on 2026-07-25 (see README.md):
 * `_meta { block { number } }` and `token(id, block:{number})` both answer,
 * and a pinned historical block returns genuinely different values than a
 * later one for the same token.
 */
export const UNISWAP_V3_MAINNET_SUBGRAPH_ID = '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';

/**
 * The manifest's `startBlock`, read off the subgraph's own error message when
 * queried before it (see README.md "Block-out-of-range"): "requested block
 * 1000, before minimum `startBlock` of manifest 12369621". Exported so a
 * caller can sanity-check a requested block before spending a round trip.
 */
export const UNISWAP_V3_MAINNET_START_BLOCK = 12369621;

/**
 * Token entity `id`s in this subgraph are the contract address, lower-cased
 * (the subgraph stores/keys them that way — see README.md "Address casing").
 * Querying with a checksummed address silently matches nothing (`token:
 * null`), so every address this adapter sends is lower-cased first.
 */
export function normalizeTokenAddress(token: string): string {
  return token.toLowerCase();
}

/**
 * How many pools (ordered by `totalValueLockedUSD` descending) this adapter
 * samples to compute `topPoolConcentrationPct`. Bounded on purpose: an exact
 * concentration figure across *every* pool a blue-chip token trades on would
 * need paginating past the gateway's 1000-row cap per query (confirmed live
 * against USDC — see README.md "topPoolConcentrationPct"), which breaks the
 * cost asymmetry SPEC.md §3 requires (verifying one claim must stay a single
 * cheap query). Sampling the top 5 keeps the query cheap and is disclosed as
 * a bound, the same honesty trade-off `ageBlocks` already makes.
 */
export const TOP_POOLS_SAMPLE_SIZE = 5;

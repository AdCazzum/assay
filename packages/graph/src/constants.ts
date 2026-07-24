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
 * `TokenSignals` fields this adapter cannot honestly source from a
 * block-pinned subgraph query in this scope (see README.md "What is left
 * unimplemented, and why"). Exported so a consumer can filter them out
 * programmatically instead of guessing from a sentinel value. Numeric fields
 * in this list are always `NaN`; `hasActiveMintRole` is always `false`. A
 * test in `adapter.test.ts` asserts the returned object actually matches
 * this list, so the two cannot silently drift apart.
 */
export const UNIMPLEMENTED_SIGNAL_KEYS = ['holders', 'top10Pct', 'transfers', 'hasActiveMintRole'] as const;

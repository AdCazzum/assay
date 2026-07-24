/**
 * Fixed, public configuration for the Token API adapter. These are canonical,
 * well-known mainnet addresses — not stand-ins for live data, just parameters
 * of the derivations documented in README.md and adapter.ts.
 */

export const DEFAULT_NETWORK = 'mainnet';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Reference token used by `getLatestBlock()` as a live proxy for "chain head"
 * (the Token API has no dedicated chain-head endpoint — see README.md
 * "getLatestBlock" section). WETH is chosen because it trades on effectively
 * every block on mainnet, so its `last_update_block_num` tracks the head
 * closely.
 */
export const HEAD_PROXY_TOKEN = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

/**
 * Canonical mainnet stablecoin contracts, used only to recognise which side
 * of a liquidity pool is USD-denominated for the `liquidityUsd` derivation
 * (see README.md). Not a price oracle: each is assumed to be worth ~$1.
 */
export const STABLECOINS: Record<string, string> = {
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
};

/** How many holders count as "top 10" for the `top10Pct` signal. */
export const TOP_HOLDERS_COUNT = 10;

/**
 * Bound on how many rows we ask for when looking for the token's oldest
 * transfer (`ageBlocks`) or recent mint activity (`hasActiveMintRole`).
 * The Token API has no way to ask "give me only the oldest transfer", so we
 * page a bounded amount and take the oldest block seen — see README.md for
 * why this is a documented lower bound, not an exact age.
 */
export const TRANSFER_SCAN_LIMIT = 1000;

/**
 * A mint (transfer from the zero address) counts as "recent" if it happened
 * within this many blocks of the block being evaluated (~7200 blocks is
 * roughly one day on mainnet at ~12s/block). See README.md
 * "hasActiveMintRole" for what this signal actually proves.
 */
export const MINT_RECENCY_BLOCKS = 7200;

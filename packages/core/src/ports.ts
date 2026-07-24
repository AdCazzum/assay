/**
 * The seams between the core and the three networks. See SPEC.md §4.
 *
 * The core depends only on these interfaces, never on ethers / the Hedera SDK /
 * the Token API directly. That is what lets the payment rail be swapped
 * (x402 <-> raw HBAR transfer) without the core noticing, and what lets each
 * adapter be built and tested on its own.
 */

import type { Manifest, ProviderRecord, Reputation } from './types.js';

/** ENS on Sepolia: identity (manifest) and portable reputation. */
export interface RegistryPort {
  resolveProvider(name: string): Promise<ProviderRecord>;
  publishManifest(name: string, manifest: Manifest): Promise<{ txHash: string }>;
  updateReputation(
    name: string,
    delta: Partial<Reputation>,
  ): Promise<{ txHash: string; reputation: Reputation }>;
}

/** Hedera testnet: pay per call, provider bond, slash. */
export interface PaymentsPort {
  /** Pays `amountHbar`, binding `requestHash` to the transaction. */
  pay(amountHbar: number, requestHash: string): Promise<{ txId: string }>;
  /** Polls the mirror node until the transaction is final. */
  confirm(txId: string): Promise<boolean>;
  postBond(amountHbar: number): Promise<{ bondRef: string; txId: string }>;
  slash(bondRef: string, toChallenger: string): Promise<{ txId: string }>;
}

/**
 * Signals for a token at a given block. The shape is deliberately open: the
 * rug-score capability picks the fields it cares about, and the verifier
 * re-derives exactly the same fields at exactly the same block.
 *
 * Every field here is a genuine, block-pinned read from a subgraph that
 * actually indexes it (see `@assay/graph`'s README for how each one was
 * verified live). This type used to also carry `holders`, `top10Pct`,
 * `transfers` and `hasActiveMintRole`, but no subgraph reachable through the
 * gateway could honestly source any of them at a pinned block, so `run()`
 * had to fill them with sentinels (`NaN`, or `false` for the boolean — which
 * is indistinguishable from a real "no mint role" claim). That is a wrong
 * slash verdict waiting to happen, so those fields were deleted rather than
 * kept as sentinels (issue #49, follow-up to #42). Fields below replace them
 * with what the Uniswap v3 subgraph genuinely exposes.
 */
export type TokenSignals = {
  atBlock: number;
  /**
   * USD value locked in the single deepest Uniswap v3 pool trading this
   * token as of `atBlock` (not a token-wide aggregate — see the graph
   * package README for why: the token-level `totalValueLockedUSD` field can
   * read `0` for a real, non-empty pool when the subgraph's own pricing
   * oracle has not been established for a very new/thin token, which is
   * exactly the case this signal exists to catch).
   */
  liquidityUsd: number;
  /**
   * `atBlock` minus the creation block of this token's earliest Uniswap v3
   * pool. `NaN` when no pool existed yet as of `atBlock` ("not observed on
   * this venue", not "brand new"). A disclosed lower bound on true token
   * age for any token that predates its first Uniswap v3 listing.
   */
  ageBlocks: number;
  /**
   * Uniswap v3 swap/mint/burn count for this token as of `atBlock`. Counts
   * Uniswap v3 activity, not raw ERC-20 `Transfer` events (the subgraph does
   * not track those) — named `txCount`, not `transfers`, so it is never
   * mistaken for the latter.
   */
  txCount: number;
  /** Cumulative tracked trading volume in USD for this token as of `atBlock`. */
  volumeUsd: number;
  /**
   * The deepest pool's `liquidityUsd` as a percentage (0..100) of the
   * combined TVL of the top 5 pools (by TVL) trading this token as of
   * `atBlock`. `100` when only one pool has ever existed. `NaN` when no
   * pool existed yet as of `atBlock`, or when the sampled pools' combined
   * TVL is `0`. A concentration signal over liquidity venues, not over
   * ERC-20 holder balances (no subgraph reachable through the gateway
   * indexes the latter — see the graph package README).
   */
  topPoolConcentrationPct: number;
};

/** The Graph Token API (mainnet, read-only): the source of truth. */
export interface GraphPort {
  getTokenSignals(token: string, atBlock?: number): Promise<TokenSignals>;
  /** The chain head, used to stamp claims at serve time. */
  getLatestBlock(): Promise<number>;
}

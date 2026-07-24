/**
 * `GraphPort` over The Graph's Token API (mainnet, read-only). See README.md
 * for how each `TokenSignals` field maps to a Token API endpoint, and for the
 * block-stamping limitations this file works around (or, for two fields,
 * cannot work around — documented, not hidden).
 */

import type { GraphPort, TokenSignals } from '@assay/core';
import {
  DEFAULT_NETWORK,
  HEAD_PROXY_TOKEN,
  MINT_RECENCY_BLOCKS,
  STABLECOINS,
  TOP_HOLDERS_COUNT,
  TRANSFER_SCAN_LIMIT,
  ZERO_ADDRESS,
} from './constants.js';
import { GraphTokenNotFoundError } from './errors.js';
import {
  parseBalanceRow,
  parseHolderRow,
  parsePoolRow,
  parseTokenMetadataRow,
  parseTransferRow,
  TokenApiClient,
  type FetchLike,
  type TokenMetadataRow,
} from './tokenApi.js';

export interface CreateGraphAdapterOptions {
  /** Token API key, sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** Injected transport; defaults to the global `fetch`. Tests pass a fake. */
  fetch?: FetchLike;
  /** Override for tests; defaults to the real Token API host. */
  baseUrl?: string;
  /** Graph Network ID; defaults to `mainnet` (constants.DEFAULT_NETWORK). */
  network?: string;
}

async function fetchTokenMetadata(client: TokenApiClient, contract: string): Promise<TokenMetadataRow> {
  const rows = await client.getRows('/v1/evm/tokens', { contract });
  if (rows.length === 0) {
    throw new GraphTokenNotFoundError(contract);
  }
  return parseTokenMetadataRow(rows[0]);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * `top10Pct` — sum of the top `TOP_HOLDERS_COUNT` holder balances (from
 * `/v1/evm/holders`, which the API describes as "top holders", i.e. already
 * sorted by balance descending) divided by circulating supply (from
 * `/v1/evm/tokens`). Both real-time only; see README.md.
 */
async function computeTop10Pct(client: TokenApiClient, contract: string, circulatingSupply: number): Promise<number> {
  if (circulatingSupply <= 0) return 0;
  const rows = await client.getRows('/v1/evm/holders', { contract, limit: TOP_HOLDERS_COUNT });
  const holders = rows.map(parseHolderRow);
  const top10Sum = holders.reduce((sum, h) => sum + h.value, 0);
  return (top10Sum / circulatingSupply) * 100;
}

/**
 * `liquidityUsd` — approximated from pools where `token` is paired directly
 * against a recognised stablecoin (see constants.STABLECOINS): the
 * stablecoin's balance held by the pool contract (from `/v1/evm/balances`,
 * treating the pool address like any other address) values that side of the
 * pool 1:1 in USD, and we double it assuming a roughly symmetric-value AMM
 * pool. See README.md "liquidityUsd" for exactly what this over/undercounts.
 */
async function computeLiquidityUsd(client: TokenApiClient, contract: string): Promise<number> {
  const [asInput, asOutput] = await Promise.all([
    client.getRows('/v1/evm/pools', { input_token: contract }),
    client.getRows('/v1/evm/pools', { output_token: contract }),
  ]);
  const pools = [...asInput, ...asOutput].map(parsePoolRow);

  const stablecoinAddresses = Object.values(STABLECOINS);
  let totalStablecoinReserve = 0;

  for (const pool of pools) {
    const otherToken = sameAddress(pool.inputToken, contract) ? pool.outputToken : pool.inputToken;
    const stablecoin = stablecoinAddresses.find((addr) => sameAddress(addr, otherToken));
    if (!stablecoin) continue;

    const balanceRows = await client.getRows('/v1/evm/balances', { address: pool.pool, contract: stablecoin });
    const balances = balanceRows.map(parseBalanceRow);
    totalStablecoinReserve += balances.reduce((sum, b) => sum + b.value, 0);
  }

  return totalStablecoinReserve * 2;
}

/**
 * Fetches the transfer window used by both `ageBlocks` and
 * `hasActiveMintRole`: everything up to `endBlock`, one page, `age: 180`
 * (the Token API's documented maximum retention). See README.md for why this
 * is a single bounded page, not a full paginated walk.
 */
async function fetchTransferWindow(client: TokenApiClient, contract: string, endBlock: number) {
  const rows = await client.getRows('/v1/evm/transfers', {
    contract,
    end_block: endBlock,
    limit: TRANSFER_SCAN_LIMIT,
    age: 180,
  });
  return rows.map(parseTransferRow);
}

/**
 * `ageBlocks` — `endBlock` minus the oldest `block_num` seen in the transfer
 * window. See README.md: this is a documented lower bound, not exact
 * deployment age, once the token has more history than one page or is older
 * than the API's ~180-day retention.
 */
function computeAgeBlocks(transfers: { blockNum: number }[], endBlock: number): number {
  if (transfers.length === 0) return 0;
  const oldest = transfers.reduce((min, t) => Math.min(min, t.blockNum), endBlock);
  return Math.max(0, endBlock - oldest);
}

/**
 * `hasActiveMintRole` — NOT a bytecode/role check (the Token API exposes no
 * contract introspection at all). This is a behavioral proxy: "has this
 * contract minted (transferred from the zero address) within
 * `MINT_RECENCY_BLOCKS` of `endBlock`?" See README.md for the false
 * negative/positive directions this can be wrong in.
 */
function computeHasActiveMintRole(transfers: { blockNum: number; from: string }[], endBlock: number): boolean {
  return transfers.some(
    (t) => sameAddress(t.from, ZERO_ADDRESS) && endBlock - t.blockNum <= MINT_RECENCY_BLOCKS,
  );
}

export function createGraphAdapter(options: CreateGraphAdapterOptions): GraphPort {
  const client = new TokenApiClient({
    apiKey: options.apiKey,
    fetch: options.fetch,
    baseUrl: options.baseUrl,
    network: options.network ?? DEFAULT_NETWORK,
  });

  return {
    async getLatestBlock(): Promise<number> {
      // The Token API has no chain-head/blocks endpoint (see README.md
      // "getLatestBlock"). We use the last-indexed block of a highly-liquid
      // reference token as a live proxy for the head.
      const head = await fetchTokenMetadata(client, HEAD_PROXY_TOKEN);
      return head.lastUpdateBlockNum;
    },

    async getTokenSignals(token: string, atBlock?: number): Promise<TokenSignals> {
      const meta = await fetchTokenMetadata(client, token);
      // `holders`, `top10Pct`, `liquidityUsd`, and `transfers` come from
      // endpoints with no historical-block filter at all (see README.md):
      // they always reflect the Token API's live indexed state, which is
      // `meta.lastUpdateBlockNum`. `atBlock` is honoured for `ageBlocks` and
      // `hasActiveMintRole` (the only two signals with a real block-range
      // query path, via /v1/evm/transfers), but the envelope's `atBlock`
      // below is always the block we could actually stand behind for the
      // majority of the fields — we never echo back a requested block we
      // did not really query.
      const resolvedBlock = meta.lastUpdateBlockNum;
      const historicalEnd = atBlock ?? resolvedBlock;

      const [top10Pct, liquidityUsd, transferWindow] = await Promise.all([
        computeTop10Pct(client, token, meta.circulatingSupply),
        computeLiquidityUsd(client, token),
        fetchTransferWindow(client, token, historicalEnd),
      ]);

      return {
        atBlock: resolvedBlock,
        holders: meta.holders,
        top10Pct,
        liquidityUsd,
        ageBlocks: computeAgeBlocks(transferWindow, historicalEnd),
        transfers: meta.totalTransfers,
        hasActiveMintRole: computeHasActiveMintRole(transferWindow, historicalEnd),
      };
    },
  };
}

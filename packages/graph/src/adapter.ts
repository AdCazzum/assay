/**
 * `GraphPort` over The Graph's decentralized gateway, querying the Uniswap v3
 * mainnet subgraph directly (not the Token API — see README.md for why, and
 * for exactly which `TokenSignals` fields this can and cannot honestly
 * source). Every query is block-pinned: a block outside the subgraph's
 * indexed range surfaces as `GraphBlockOutOfRangeError`, never a silent
 * approximation.
 */

import type { GraphPort, TokenSignals } from '@assay/core';
import { normalizeTokenAddress, TOP_POOLS_SAMPLE_SIZE, UNISWAP_V3_MAINNET_SUBGRAPH_ID } from './constants.js';
import { GraphTokenNotFoundError } from './errors.js';
import {
  parseMetaBlockNumber,
  parseOldestPoolRow,
  parseTokenRow,
  parseTopPoolRow,
  SubgraphClient,
  type FetchLike,
} from './gatewayClient.js';

export interface CreateGraphAdapterOptions {
  /** The Graph API key, sent as part of the gateway URL path. */
  apiKey: string;
  /** Injected transport; defaults to the global `fetch`. Tests pass a fake. */
  fetch?: FetchLike;
  /** Override for tests; defaults to the real gateway host. */
  baseUrl?: string;
  /** Override for tests; defaults to the Uniswap v3 mainnet subgraph. */
  subgraphId?: string;
}

const META_QUERY = `{ _meta { block { number } } }`;

/**
 * Fetches every real `TokenSignals` field for one token, pinned to the same
 * `$block`, in one round trip:
 *
 * - `token.txCount` / `token.volumeUSD` -> `txCount` / `volumeUsd`.
 * - `oldestPool` (pools ordered by `createdAtBlockNumber` ascending, first 1)
 *   -> `ageBlocks`.
 * - `topPools` (pools ordered by `totalValueLockedUSD` descending, first
 *   `TOP_POOLS_SAMPLE_SIZE`) -> `liquidityUsd` (the top one) and
 *   `topPoolConcentrationPct` (the top one over the sampled group's total).
 *
 * See README.md for why `liquidityUsd` is sourced from the deepest *pool*
 * rather than the token-level `totalValueLockedUSD` aggregate this package
 * used before #49.
 */
const TOKEN_SIGNALS_QUERY = `
  query TokenSignals($id: ID!, $block: Int!, $topPoolsFirst: Int!) {
    token(id: $id, block: { number: $block }) {
      txCount
      volumeUSD
    }
    oldestPool: pools(
      where: { or: [{ token0: $id }, { token1: $id }] }
      orderBy: createdAtBlockNumber
      orderDirection: asc
      first: 1
      block: { number: $block }
    ) {
      createdAtBlockNumber
    }
    topPools: pools(
      where: { or: [{ token0: $id }, { token1: $id }] }
      orderBy: totalValueLockedUSD
      orderDirection: desc
      first: $topPoolsFirst
      block: { number: $block }
    ) {
      totalValueLockedUSD
    }
  }
`;

interface TokenSignalsQueryResult {
  token: unknown;
  oldestPool: unknown[];
  topPools: unknown[];
}

interface MetaQueryResult {
  _meta: unknown;
}

export function createGraphAdapter(options: CreateGraphAdapterOptions): GraphPort {
  const client = new SubgraphClient({
    apiKey: options.apiKey,
    fetch: options.fetch,
    baseUrl: options.baseUrl,
    subgraphId: options.subgraphId ?? UNISWAP_V3_MAINNET_SUBGRAPH_ID,
  });

  async function fetchLatestBlock(): Promise<number> {
    const data = await client.query<MetaQueryResult>(META_QUERY);
    return parseMetaBlockNumber(data._meta);
  }

  return {
    async getLatestBlock(): Promise<number> {
      // `_meta` reports the block this subgraph's own indexers have reached
      // — not the true chain head from an RPC provider, which could be
      // ahead of what this subgraph can actually answer for (see README.md
      // "getLatestBlock: report a head you can query"). Using this
      // subgraph's own head guarantees a subsequent `getTokenSignals(token,
      // head)` call is pinnable.
      return fetchLatestBlock();
    },

    async getTokenSignals(token: string, atBlock?: number): Promise<TokenSignals> {
      const id = normalizeTokenAddress(token);
      // Address casing matters: this subgraph keys `Token.id` by the
      // lower-cased contract address, so a checksummed address silently
      // matches nothing (`token: null`) rather than erroring — see
      // README.md "Address casing".
      const block = atBlock ?? (await fetchLatestBlock());

      const data = await client.query<TokenSignalsQueryResult>(
        TOKEN_SIGNALS_QUERY,
        { id, block, topPoolsFirst: TOP_POOLS_SAMPLE_SIZE },
        { atBlock: block },
      );

      if (data.token === null || data.token === undefined) {
        throw new GraphTokenNotFoundError(token);
      }
      const tokenRow = parseTokenRow(data.token);

      // `ageBlocks` is `NaN` when no Uniswap v3 pool for this token existed
      // as of `block` — "not observed on this venue as of this block", not
      // "age zero". See README.md "ageBlocks".
      const oldestPool = data.oldestPool[0];
      const ageBlocks =
        oldestPool === undefined ? NaN : Math.max(0, block - parseOldestPoolRow(oldestPool).createdAtBlockNumber);

      // `liquidityUsd` / `topPoolConcentrationPct`: NaN when no pool existed
      // yet as of `block`, same "not observed" reasoning as ageBlocks. When
      // pools do exist, `liquidityUsd` is the deepest one's own TVL, and
      // `topPoolConcentrationPct` is that same figure as a percentage of
      // the sampled group's total (100 when only one pool was found; NaN if
      // the sampled group's total TVL is 0).
      const topPoolTvls = data.topPools.map((row) => parseTopPoolRow(row).totalValueLockedUsd);
      const liquidityUsd = topPoolTvls.length === 0 ? NaN : topPoolTvls[0];
      const sampledTvl = topPoolTvls.reduce((sum, tvl) => sum + tvl, 0);
      const topPoolConcentrationPct =
        topPoolTvls.length === 0 ? NaN : sampledTvl === 0 ? NaN : (topPoolTvls[0] / sampledTvl) * 100;

      return {
        atBlock: block,
        liquidityUsd,
        ageBlocks,
        txCount: tokenRow.txCount,
        volumeUsd: tokenRow.volumeUsd,
        topPoolConcentrationPct,
      };
    },
  };
}

/**
 * `GraphPort` over The Graph's decentralized gateway, querying the Uniswap v3
 * mainnet subgraph directly (not the Token API — see README.md for why, and
 * for exactly which `TokenSignals` fields this can and cannot honestly
 * source). Every query is block-pinned: a block outside the subgraph's
 * indexed range surfaces as `GraphBlockOutOfRangeError`, never a silent
 * approximation.
 */

import type { GraphPort, TokenSignals } from '@assay/core';
import { normalizeTokenAddress, UNISWAP_V3_MAINNET_SUBGRAPH_ID } from './constants.js';
import { GraphTokenNotFoundError } from './errors.js';
import {
  parseMetaBlockNumber,
  parsePoolRow,
  parseTokenRow,
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
 * Fetches `token.totalValueLockedUSD` (→ `liquidityUsd`) and the
 * earliest-created Uniswap v3 pool trading this token (→ `ageBlocks`), both
 * pinned to the same `$block` in one round trip. See README.md for what each
 * derivation means and its known limits.
 */
const TOKEN_SIGNALS_QUERY = `
  query TokenSignals($id: ID!, $block: Int!) {
    token(id: $id, block: { number: $block }) {
      totalValueLockedUSD
    }
    pools(
      where: { or: [{ token0: $id }, { token1: $id }] }
      orderBy: createdAtBlockNumber
      orderDirection: asc
      first: 1
      block: { number: $block }
    ) {
      createdAtBlockNumber
    }
  }
`;

interface TokenSignalsQueryResult {
  token: unknown;
  pools: unknown[];
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
        { id, block },
        { atBlock: block },
      );

      if (data.token === null || data.token === undefined) {
        throw new GraphTokenNotFoundError(token);
      }
      const tokenRow = parseTokenRow(data.token);

      // `ageBlocks` is `NaN` when no Uniswap v3 pool for this token existed
      // as of `block` — "not observed on this venue as of this block", not
      // "age zero". See README.md "ageBlocks".
      const earliestPool = data.pools[0];
      const ageBlocks = earliestPool === undefined ? NaN : Math.max(0, block - parsePoolRow(earliestPool).createdAtBlockNumber);

      return {
        atBlock: block,
        // Unimplemented in this scope: no subgraph verified queryable
        // through this gateway exposes holder counts, a balance-ranked top
        // holder list, or contract-level mint-role introspection. See
        // README.md "What is left unimplemented, and why" and
        // `UNIMPLEMENTED_SIGNAL_KEYS` in constants.ts.
        holders: NaN,
        top10Pct: NaN,
        liquidityUsd: tokenRow.totalValueLockedUsd,
        ageBlocks,
        transfers: NaN,
        hasActiveMintRole: false,
      };
    },
  };
}

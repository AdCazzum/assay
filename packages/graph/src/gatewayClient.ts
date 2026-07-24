/**
 * Thin, typed client over The Graph's decentralized gateway
 * (`https://gateway.thegraph.com/api/<key>/subgraphs/id/<id>` — see
 * README.md "Which subgraph, and how it was verified"). No GraphQL client or
 * schema library is added: `fetch` is injected (see
 * `SubgraphClientOptions.fetch`) so tests can drive a fake
 * (`FakeGatewayFetch` in `adapter.test.ts`), and response fields are
 * validated by hand below instead of a schema library, same as the
 * pre-existing `tokenApi.ts` this file replaces.
 */

import {
  GraphApiError,
  GraphBlockOutOfRangeError,
  GraphMalformedResponseError,
  GraphRateLimitError,
} from './errors.js';

export type FetchLike = typeof fetch;

export interface SubgraphClientOptions {
  /** The Graph API key, embedded in the gateway URL path. */
  apiKey: string;
  /** Which subgraph (by deployment/subgraph id) to query. */
  subgraphId: string;
  /** Injected transport. Defaults to the global `fetch`. Tests pass a fake. */
  fetch?: FetchLike;
  /** Defaults to the real gateway host; tests override with a fake origin. */
  baseUrl?: string;
}

interface GraphQlError {
  message: string;
}

interface GatewayEnvelope {
  data?: unknown;
  errors?: GraphQlError[];
}

function isGatewayEnvelope(body: unknown): body is GatewayEnvelope {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return 'data' in b || 'errors' in b;
}

/**
 * Recognises the two real block-range failure shapes this gateway sends
 * (see README.md "Block-out-of-range", both captured from live queries
 * against this subgraph on 2026-07-25):
 *
 * - too early: `bad query: ... requested block N, before minimum
 *   \`startBlock\` of manifest M`
 * - too late (indexers have not caught up to N yet): `bad indexers: {...:
 *   Unavailable(missing block: N, latest: M), ...}`
 *
 * Anything else is a genuine query/transport problem, not a block-range one,
 * and is left as a plain `GraphApiError`.
 */
function classifyBlockRangeError(message: string): 'before-start' | 'not-yet-indexed' | undefined {
  if (/before minimum `startBlock`/.test(message)) return 'before-start';
  if (/missing block|Unavailable\(/.test(message)) return 'not-yet-indexed';
  return undefined;
}

export class SubgraphClient {
  private readonly fetchFn: FetchLike;
  private readonly endpoint: string;

  constructor(options: SubgraphClientOptions) {
    if (!options.apiKey) {
      throw new Error('SubgraphClient requires apiKey (GRAPH_API_KEY)');
    }
    if (!options.subgraphId) {
      throw new Error('SubgraphClient requires subgraphId');
    }
    this.fetchFn = options.fetch ?? globalThis.fetch;
    const baseUrl = options.baseUrl ?? 'https://gateway.thegraph.com/api';
    this.endpoint = `${baseUrl}/${options.apiKey}/subgraphs/id/${options.subgraphId}`;
  }

  /**
   * Runs a GraphQL query against the gateway. When `blockContext` is given,
   * a GraphQL-level error recognised as a block-range problem (see
   * `classifyBlockRangeError`) is thrown as `GraphBlockOutOfRangeError`
   * instead of a generic `GraphApiError` — this is what lets a caller that
   * pinned a query to `atBlock` catch specifically that failure.
   */
  async query<T>(gqlQuery: string, variables?: Record<string, unknown>, blockContext?: { atBlock: number }): Promise<T> {
    const res = await this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: gqlQuery, variables }),
    });

    if (res.status === 429) {
      const retryAfterHeader = res.headers.get('Retry-After');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      const body = await safeJson(res);
      throw new GraphRateLimitError(
        'Gateway rate limit hit',
        body,
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
      );
    }

    if (!res.ok) {
      const body = await safeJson(res);
      throw new GraphApiError(`Gateway responded ${res.status}`, res.status, body);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (cause) {
      throw new GraphApiError('Gateway returned a non-JSON body', res.status, cause);
    }

    if (!isGatewayEnvelope(body)) {
      throw new GraphApiError('Gateway response had neither "data" nor "errors"', res.status, body);
    }

    if (body.errors && body.errors.length > 0) {
      const message = body.errors.map((e) => e.message).join('; ');
      if (blockContext) {
        const reason = classifyBlockRangeError(message);
        if (reason) {
          throw new GraphBlockOutOfRangeError(blockContext.atBlock, reason, message);
        }
      }
      throw new GraphApiError(`Subgraph query returned errors: ${message}`, res.status, body.errors);
    }

    return body.data as T;
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

// ---- Row shapes + hand-rolled validation ------------------------------------
//
// Fields below are transcribed from the Uniswap v3 mainnet subgraph schema
// (verified live 2026-07-25 — see README.md) and validated defensively: a
// missing/mistyped field throws rather than silently becoming
// `undefined`/`NaN` and corrupting a signal. Note the subgraph serialises
// `BigInt`/`BigDecimal` scalars (block numbers, TVL) as JSON strings, but
// plain `Int` scalars (like `_meta.block.number`) as JSON numbers — both are
// handled below.

function asRow(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new GraphMalformedResponseError(`expected an object for "${field}"`, field, value);
  }
  return value as Record<string, unknown>;
}

function requireField(row: Record<string, unknown>, key: string, field: string): unknown {
  if (!(key in row)) {
    throw new GraphMalformedResponseError(`missing field "${key}" in "${field}"`, field, row);
  }
  return row[key];
}

/** For `BigInt`/`BigDecimal` scalars, serialised as JSON strings. */
function asNumericString(row: Record<string, unknown>, key: string, field: string): number {
  const v = requireField(row, key, field);
  if (typeof v !== 'string') {
    throw new GraphMalformedResponseError(`field "${key}" in "${field}" was not a numeric string`, field, row);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new GraphMalformedResponseError(`field "${key}" in "${field}" was not a finite number`, field, row);
  }
  return n;
}

/** For plain `Int` scalars, serialised as JSON numbers. */
function asIntNumber(row: Record<string, unknown>, key: string, field: string): number {
  const v = requireField(row, key, field);
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new GraphMalformedResponseError(`field "${key}" in "${field}" was not a finite number`, field, row);
  }
  return v;
}

/** `token { txCount, volumeUSD }` */
export interface TokenRow {
  txCount: number;
  volumeUsd: number;
}

export function parseTokenRow(value: unknown): TokenRow {
  const row = asRow(value, 'token');
  return {
    txCount: asNumericString(row, 'txCount', 'token'),
    volumeUsd: asNumericString(row, 'volumeUSD', 'token'),
  };
}

/** `pools { createdAtBlockNumber }`, from the oldest-first query (for `ageBlocks`). */
export interface OldestPoolRow {
  createdAtBlockNumber: number;
}

export function parseOldestPoolRow(value: unknown): OldestPoolRow {
  const row = asRow(value, 'pool');
  return {
    createdAtBlockNumber: asNumericString(row, 'createdAtBlockNumber', 'pool'),
  };
}

/** `pools { totalValueLockedUSD }`, from the TVL-ordered query (for `liquidityUsd` / `topPoolConcentrationPct`). */
export interface TopPoolRow {
  totalValueLockedUsd: number;
}

export function parseTopPoolRow(value: unknown): TopPoolRow {
  const row = asRow(value, 'pool');
  return {
    totalValueLockedUsd: asNumericString(row, 'totalValueLockedUSD', 'pool'),
  };
}

/** `_meta { block { number } }` */
export function parseMetaBlockNumber(value: unknown): number {
  const row = asRow(value, '_meta');
  const block = asRow(requireField(row, 'block', '_meta'), '_meta.block');
  return asIntNumber(block, 'number', '_meta.block');
}

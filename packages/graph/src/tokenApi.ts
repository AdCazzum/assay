/**
 * Thin, typed client over The Graph's Token API (served by Pinax at
 * https://api.pinax.network — see README.md "Which endpoints" for how each
 * path was found and verified). No dependency is added for HTTP or schema
 * validation: `fetch` is injected (see `TokenApiClientOptions.fetch`) so
 * tests can drive a fake, and response rows are validated by hand with small
 * guards below instead of a schema library.
 */

import { GraphApiError, GraphMalformedResponseError, GraphRateLimitError } from './errors.js';

export type FetchLike = typeof fetch;

export interface TokenApiClientOptions {
  /** Bearer token for `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** Injected transport. Defaults to the global `fetch`. Tests pass a fake. */
  fetch?: FetchLike;
  /** Defaults to the real Token API host; tests override with a fake origin. */
  baseUrl?: string;
  /** Graph Network ID. Defaults to `mainnet` (see constants.ts). */
  network?: string;
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

interface TokenApiEnvelope {
  data: unknown[];
}

function isTokenApiEnvelope(body: unknown): body is TokenApiEnvelope {
  return typeof body === 'object' && body !== null && Array.isArray((body as { data?: unknown }).data);
}

function buildUrl(baseUrl: string, path: string, params: QueryParams): string {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export class TokenApiClient {
  private readonly apiKey: string;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;
  readonly network: string;

  constructor(options: TokenApiClientOptions) {
    if (!options.apiKey) {
      throw new Error('TokenApiClient requires apiKey (GRAPH_API_KEY)');
    }
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? 'https://api.pinax.network';
    this.network = options.network ?? 'mainnet';
  }

  /** GETs `path` with `params`, always injecting `network`. Returns the `data` rows, unparsed. */
  async getRows(path: string, params: QueryParams = {}): Promise<unknown[]> {
    const url = buildUrl(this.baseUrl, path, { network: this.network, ...params });
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (res.status === 429) {
      const retryAfterHeader = res.headers.get('Retry-After');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      throw new GraphRateLimitError(
        `Token API rate limit hit for ${path}`,
        body,
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
      );
    }

    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      throw new GraphApiError(`Token API ${res.status} on ${path}`, res.status, body);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (cause) {
      throw new GraphApiError(`Token API returned non-JSON body for ${path}`, res.status, cause);
    }

    if (!isTokenApiEnvelope(body)) {
      throw new GraphApiError(`Token API response for ${path} was missing a "data" array`, res.status, body);
    }

    return body.data;
  }
}

// ---- Row shapes + hand-rolled validation ------------------------------------
//
// The Token API has no published JSON Schema / OpenAPI we could fetch (see
// README.md). Field names below are transcribed from the rendered endpoint
// docs at https://app.pinax.network/docs/api/... (checked 2026-07-24) and
// are intentionally validated defensively: a missing/mistyped field throws
// rather than silently becoming `undefined`/`NaN` and corrupting a signal.

function field(row: Record<string, unknown>, key: string, path: string): unknown {
  if (!(key in row)) {
    throw new GraphMalformedResponseError(`Token API row from ${path} is missing field "${key}"`, path, row);
  }
  return row[key];
}

function asString(row: Record<string, unknown>, key: string, path: string): string {
  const v = field(row, key, path);
  if (typeof v !== 'string') {
    throw new GraphMalformedResponseError(`Token API row from ${path} field "${key}" was not a string`, path, row);
  }
  return v;
}

function asFiniteNumber(row: Record<string, unknown>, key: string, path: string): number {
  const v = field(row, key, path);
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new GraphMalformedResponseError(
      `Token API row from ${path} field "${key}" was not a finite number`,
      path,
      row,
    );
  }
  return n;
}

function asRow(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new GraphMalformedResponseError(`Token API row from ${path} was not an object`, path, value);
  }
  return value as Record<string, unknown>;
}

/** `/v1/evm/tokens` — see README.md "Token metadata". */
export interface TokenMetadataRow {
  contract: string;
  circulatingSupply: number;
  holders: number;
  totalTransfers: number;
  lastUpdateBlockNum: number;
}

export function parseTokenMetadataRow(value: unknown): TokenMetadataRow {
  const path = '/v1/evm/tokens';
  const row = asRow(value, path);
  return {
    contract: asString(row, 'contract', path),
    circulatingSupply: asFiniteNumber(row, 'circulating_supply', path),
    holders: asFiniteNumber(row, 'holders', path),
    totalTransfers: asFiniteNumber(row, 'total_transfers', path),
    lastUpdateBlockNum: asFiniteNumber(row, 'last_update_block_num', path),
  };
}

/** `/v1/evm/holders` — see README.md "top10Pct". */
export interface HolderRow {
  address: string;
  value: number;
}

export function parseHolderRow(value: unknown): HolderRow {
  const path = '/v1/evm/holders';
  const row = asRow(value, path);
  return {
    address: asString(row, 'address', path),
    value: asFiniteNumber(row, 'value', path),
  };
}

/** `/v1/evm/transfers` — see README.md "ageBlocks" and "hasActiveMintRole". */
export interface TransferRow {
  blockNum: number;
  from: string;
  to: string;
}

export function parseTransferRow(value: unknown): TransferRow {
  const path = '/v1/evm/transfers';
  const row = asRow(value, path);
  return {
    blockNum: asFiniteNumber(row, 'block_num', path),
    from: asString(row, 'from', path),
    to: asString(row, 'to', path),
  };
}

/** `/v1/evm/pools` — see README.md "liquidityUsd". */
export interface PoolRow {
  pool: string;
  inputToken: string;
  outputToken: string;
}

export function parsePoolRow(value: unknown): PoolRow {
  const path = '/v1/evm/pools';
  const row = asRow(value, path);
  const inputToken = asRow(field(row, 'input_token', path), path);
  const outputToken = asRow(field(row, 'output_token', path), path);
  return {
    pool: asString(row, 'pool', path),
    inputToken: asString(inputToken, 'address', path),
    outputToken: asString(outputToken, 'address', path),
  };
}

/** `/v1/evm/balances` — see README.md "liquidityUsd". */
export interface BalanceRow {
  address: string;
  contract: string;
  value: number;
}

export function parseBalanceRow(value: unknown): BalanceRow {
  const path = '/v1/evm/balances';
  const row = asRow(value, path);
  return {
    address: asString(row, 'address', path),
    contract: asString(row, 'contract', path),
    value: asFiniteNumber(row, 'value', path),
  };
}

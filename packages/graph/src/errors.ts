/**
 * Typed errors for the Token API adapter. Callers (cap-rugscore's verifier,
 * the provider, the demo scripts) need to branch on *why* a call failed, so
 * we never let a bare `Error` or an un-typed HTTP rejection leak out.
 */

/** The Token API answered, but not with 2xx. Carries the status + parsed body for diagnostics. */
export class GraphApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'GraphApiError';
    this.status = status;
    this.body = body;
  }
}

/** The Token API answered 429. Separate from GraphApiError so callers can retry/back off specifically. */
export class GraphRateLimitError extends GraphApiError {
  /** Value of a `Retry-After` response header, in seconds, when the API sends one. */
  readonly retryAfterSeconds?: number;

  constructor(message: string, body?: unknown, retryAfterSeconds?: number) {
    super(message, 429, body);
    this.name = 'GraphRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Raised when `token` has no data in the Token API at all (never indexed / not
 * an ERC-20 on this network), as opposed to a transport-level failure.
 */
export class GraphTokenNotFoundError extends Error {
  readonly token: string;

  constructor(token: string) {
    super(`Token API has no data for contract ${token}`);
    this.name = 'GraphTokenNotFoundError';
    this.token = token;
  }
}

/**
 * The Token API answered 2xx, but a row was missing a field this adapter
 * relies on, or had the wrong type. Distinct from `GraphApiError` (an HTTP
 * failure): this is a schema-shape failure, so it never has a real HTTP
 * status to report — better than reusing `GraphApiError` with a fake 200.
 */
export class GraphMalformedResponseError extends Error {
  readonly endpoint: string;
  readonly row: unknown;

  constructor(message: string, endpoint: string, row: unknown) {
    super(message);
    this.name = 'GraphMalformedResponseError';
    this.endpoint = endpoint;
    this.row = row;
  }
}

/**
 * Typed errors for the subgraph adapter. Callers (cap-rugscore's verifier,
 * the provider, the demo scripts) need to branch on *why* a call failed, so
 * we never let a bare `Error`, an un-typed HTTP rejection, or a GraphQL
 * `errors[]` array leak out unparsed.
 */

/** The gateway answered, but not with 2xx. Carries the status + parsed body for diagnostics. */
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

/** The gateway answered 429. Separate from GraphApiError so callers can retry/back off specifically. */
export class GraphRateLimitError extends GraphApiError {
  /** Value of a `Retry-After` response header, in seconds, when the gateway sends one. */
  readonly retryAfterSeconds?: number;

  constructor(message: string, body?: unknown, retryAfterSeconds?: number) {
    super(message, 429, body);
    this.name = 'GraphRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The requested `atBlock` is outside the range this subgraph can honestly
 * answer for right now: before the manifest's indexed `startBlock`, or at or
 * after a block some of the gateway's indexers have not caught up to yet.
 * This is the error SPEC §12 requires: a caller must see this loudly, never
 * a silent fallback to live/approximated data. See README.md
 * "Block-out-of-range" for the two real error shapes this wraps.
 */
export class GraphBlockOutOfRangeError extends Error {
  readonly atBlock: number;
  /** `'before-start'` — before the subgraph's indexed history. `'not-yet-indexed'` — past what the gateway's indexers have processed so far. */
  readonly reason: 'before-start' | 'not-yet-indexed';
  /** The raw GraphQL error message(s) this was parsed from, for diagnostics. */
  readonly detail: string;

  constructor(atBlock: number, reason: 'before-start' | 'not-yet-indexed', detail: string) {
    super(`Block ${atBlock} is out of range for this subgraph (${reason}): ${detail}`);
    this.name = 'GraphBlockOutOfRangeError';
    this.atBlock = atBlock;
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Raised when `token` has no data in the subgraph at all (never traded on
 * this venue, or not an ERC-20 contract), as opposed to a transport-level
 * failure or a block-range failure.
 */
export class GraphTokenNotFoundError extends Error {
  readonly token: string;

  constructor(token: string) {
    super(`Subgraph has no token entity for contract ${token}`);
    this.name = 'GraphTokenNotFoundError';
    this.token = token;
  }
}

/**
 * The gateway answered 2xx with no `errors[]`, but a field this adapter
 * relies on was missing or had a shape we did not expect. Distinct from
 * `GraphApiError` (an HTTP/GraphQL-level failure): this is a schema-shape
 * failure, so it never has a real HTTP status to report.
 */
export class GraphMalformedResponseError extends Error {
  readonly field: string;
  readonly value: unknown;

  constructor(message: string, field: string, value: unknown) {
    super(message);
    this.name = 'GraphMalformedResponseError';
    this.field = field;
    this.value = value;
  }
}

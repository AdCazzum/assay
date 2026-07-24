/** Named errors for `ProviderService`. See `service.ts`. */

/** Raised when a raw serve request is missing or misshapes a required field. */
export class MalformedServeRequestError extends Error {
  constructor(reason: string) {
    super(`Malformed serve request: ${reason}`);
    this.name = 'MalformedServeRequestError';
  }
}

/**
 * Raised when `AssayNode#serve()` has not settled within the provider's
 * configured timeout. See `timeout.ts` for why this exists alongside (not
 * instead of) the requester-side timeout SPEC.md §12 calls for.
 */
export class ServeTimeoutError extends Error {
  readonly txId: string;
  readonly timeoutMs: number;

  constructor(txId: string, timeoutMs: number) {
    super(
      `serve() for payment "${txId}" did not resolve within ${timeoutMs}ms. Refusing to wait ` +
        'forever on a payment that may never confirm; the caller should retry with a fresh payment.',
    );
    this.name = 'ServeTimeoutError';
    this.txId = txId;
    this.timeoutMs = timeoutMs;
  }
}

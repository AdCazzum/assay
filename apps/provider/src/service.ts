/**
 * `ProviderService` — the provider-facing wrapper around `AssayNode#serve()`
 * (issue #8, SPEC.md §4 step 4, §12).
 *
 * The payment gate itself already lives in `@assay/core`'s `serve()`: it
 * calls `payments.confirm(txId)` unconditionally before running any
 * capability, and this file never reimplements or works around that. What
 * this file adds, in front of the gate:
 *
 *  1. Request validation, so a malformed request is rejected before `serve()`
 *     (and therefore before `payments.confirm()`) is ever called.
 *  2. A bounded wait on `serve()` (see `timeout.ts`), so a payment that never
 *     confirms times out instead of hanging the caller forever.
 *  3. A refusal shape (`ServeOutcome`) with a clear machine-readable `code`
 *     and a human `reason`, instead of a thrown exception the transport layer
 *     would have to guess how to map to a response.
 */

import type { AssayNode, Job } from '@assay/core';
import { PaymentNotConfirmedError } from '@assay/core';
import { MalformedServeRequestError, ServeTimeoutError } from './errors.js';
import { withTimeout } from './timeout.js';

/** Bounds how long a single `serve()` call is allowed to run. See `timeout.ts`. */
export const DEFAULT_SERVE_TIMEOUT_MS = 20_000;

/**
 * The untrusted shape a serve request arrives in (e.g. an HTTP JSON body).
 * Every field is `unknown` on purpose: nothing about the caller is trusted
 * until `validateServeRequest` says so.
 */
export type RawServeRequest = {
  provider?: unknown;
  capabilityId?: unknown;
  request?: unknown;
  txId?: unknown;
};

export type ValidServeRequest = {
  provider: string;
  capabilityId: string;
  request: unknown;
  txId: string;
};

export type ServeRefusalCode = 'malformed_request' | 'payment_not_confirmed' | 'timeout' | 'internal_error';

export type ServeOutcome =
  | { ok: true; job: Job }
  | { ok: false; code: ServeRefusalCode; reason: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Validates a raw, untrusted serve request. Returns a typed, safe-to-use
 * request on success, or a human-readable reason on failure — never throws,
 * so callers (e.g. the HTTP layer) don't need a try/catch just to refuse a
 * bad request.
 */
export function validateServeRequest(
  raw: RawServeRequest,
): { ok: true; value: ValidServeRequest } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reason: 'request body must be a JSON object' };
  }
  if (!isNonEmptyString(raw.provider)) {
    return { ok: false, reason: '"provider" must be a non-empty string' };
  }
  if (!isNonEmptyString(raw.capabilityId)) {
    return { ok: false, reason: '"capabilityId" must be a non-empty string' };
  }
  if (!isNonEmptyString(raw.txId)) {
    return { ok: false, reason: '"txId" must be a non-empty string (the payment this request must be confirmed by)' };
  }
  if (raw.request === undefined) {
    return { ok: false, reason: '"request" is required (the capability input)' };
  }
  return {
    ok: true,
    value: { provider: raw.provider, capabilityId: raw.capabilityId, request: raw.request, txId: raw.txId },
  };
}

export type ProviderServiceDeps = {
  /**
   * The gated entry point this service fronts. Typed as just the one
   * function it needs off `AssayNode` (not the whole node), so tests can pass
   * `node.serve` straight from a real `createAssayNode(...)` wired with fake
   * ports, without this file needing to know about `discover`/`register`/etc.
   */
  serve: AssayNode['serve'];
  /** Overrides `DEFAULT_SERVE_TIMEOUT_MS`. */
  serveTimeoutMs?: number;
};

export interface ProviderService {
  /**
   * Validates, then serves, a raw request. Never throws: every outcome,
   * including refusals, comes back as a `ServeOutcome` so a transport layer
   * (see `http-server.ts`) can map it to a response without a try/catch.
   */
  handle(raw: RawServeRequest): Promise<ServeOutcome>;
}

/** Builds a `ProviderService` over `deps.serve` (see `ProviderServiceDeps`). */
export function createProviderService(deps: ProviderServiceDeps): ProviderService {
  const serveTimeoutMs = deps.serveTimeoutMs ?? DEFAULT_SERVE_TIMEOUT_MS;

  return {
    async handle(raw) {
      const validated = validateServeRequest(raw);
      if (!validated.ok) {
        return { ok: false, code: 'malformed_request', reason: new MalformedServeRequestError(validated.reason).message };
      }

      const { value: input } = validated;

      try {
        const job = await withTimeout(
          deps.serve(input),
          serveTimeoutMs,
          () => new ServeTimeoutError(input.txId, serveTimeoutMs),
        );
        return { ok: true, job };
      } catch (err) {
        if (err instanceof PaymentNotConfirmedError) {
          return { ok: false, code: 'payment_not_confirmed', reason: err.message };
        }
        if (err instanceof ServeTimeoutError) {
          return { ok: false, code: 'timeout', reason: err.message };
        }
        return { ok: false, code: 'internal_error', reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

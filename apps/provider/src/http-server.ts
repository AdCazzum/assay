/**
 * The endpoint SPEC.md §4/§5's `Manifest.endpoint` field points at: a
 * minimal HTTP front for `ProviderService` (issue #8). Uses `node:http`
 * only — no framework, so no new dependency (AGENTS.md forbids adding one).
 *
 * `POST /serve` with a JSON body `{ provider, capabilityId, request, txId }`
 * is the only route. Everything about *whether* to serve lives in
 * `ProviderService`; this file only translates its `ServeOutcome` to an HTTP
 * status + JSON body.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ProviderService, RawServeRequest, ServeOutcome, ServeRefusalCode } from './service.js';

const STATUS_BY_REFUSAL_CODE: Record<ServeRefusalCode, number> = {
  // 400: the caller's request itself is invalid, independent of payment.
  malformed_request: 400,
  // 402 Payment Required: the semantically-correct status for "pay first".
  payment_not_confirmed: 402,
  // 504 Gateway Timeout: this service gave up waiting on a downstream (the
  // payment confirmation), not that the client's own request timed out.
  timeout: 504,
  internal_error: 500,
};

const MAX_BODY_BYTES = 1_000_000;

class BodyTooLargeError extends Error {}
class InvalidJsonError extends Error {}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;

    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new InvalidJsonError('request body is not valid JSON'));
      }
    });

    req.on('error', reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function statusFor(outcome: ServeOutcome): number {
  return outcome.ok ? 200 : STATUS_BY_REFUSAL_CODE[outcome.code];
}

/** Builds (but does not start) an HTTP server fronting `service`. */
export function createProviderHttpServer(service: ProviderService): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/serve') {
      writeJson(res, 404, { ok: false, code: 'not_found', reason: 'POST /serve is the only route' });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      writeJson(res, err instanceof BodyTooLargeError ? 413 : 400, {
        ok: false,
        code: 'malformed_request',
        reason,
      });
      return;
    }

    const outcome = await service.handle(body as RawServeRequest);
    writeJson(res, statusFor(outcome), outcome);
  });
}

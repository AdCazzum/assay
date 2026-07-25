/**
 * Hedera mirror node polling. See SPEC.md §9, §12: the provider serves only
 * after `confirm(txId)` settles, and the demo's "sub-second settlement" claim
 * rests on this being fast and its timing observable.
 *
 * Deliberately minimal: a plain REST poll of `/api/v1/transactions/{id}`, no
 * websocket subscription. The mirror node is eventually consistent with
 * consensus (typically ~1-2s lag on testnet), so this is a short bounded poll,
 * not a long-lived watch.
 */

/**
 * The only shape of `fetch` this module needs. Kept narrower than the global
 * `fetch` type so a fake can implement it in tests without reaching for a real
 * `Response`.
 */
export type FetchLike = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;

export type MirrorNodePollState = 'pending' | 'success' | 'failed';

export type MirrorNodePollAttempt = {
  attempt: number;
  elapsedMs: number;
  state: MirrorNodePollState;
};

export type MirrorNodePollConfig = {
  /** e.g. "https://testnet.mirrornode.hedera.com" (no trailing slash required). */
  baseUrl: string;
  fetchImpl: FetchLike;
  /** Bounded wait for the mirror node to ingest and finalize the tx. Default 15s. */
  timeoutMs?: number;
  /** Poll interval. Default 1s, matching typical mirror node ingestion lag. */
  intervalMs?: number;
  /** Injectable sleep, so tests can drive the state machine without real waits if needed. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Called on every poll, so callers (and tests) can observe the settle timing. */
  onAttempt?: (info: MirrorNodePollAttempt) => void;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_MS = 1_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Raised when the mirror node never ingests/finalizes `txId` within the timeout. */
export class MirrorNodeTimeoutError extends Error {
  readonly txId: string;
  readonly timeoutMs: number;

  constructor(txId: string, timeoutMs: number) {
    super(`mirror node did not finalize transaction ${txId} within ${timeoutMs}ms`);
    this.name = 'MirrorNodeTimeoutError';
    this.txId = txId;
    this.timeoutMs = timeoutMs;
  }
}

type MirrorNodeTransactionsResponse = {
  transactions?: Array<{
    result: string;
    transfers?: Array<{ account: string; amount: number }>;
    memo_base64?: string | null;
  }>;
};

/** One account's tinybar delta in a transaction's transfer list (negative for the payer). */
export type MirrorNodeTransfer = {
  accountId: string;
  amountTinybars: number;
};

/**
 * The full shape `pollMirrorNodeTransaction` resolves once the transaction is
 * final: not just whether it succeeded, but what it actually moved, so a
 * caller (see `@assay/core`'s `serve()`) can check the transaction was for the
 * amount, recipient, and memo it expects instead of trusting any SUCCESS tx.
 */
export type MirrorNodeTransactionDetail = {
  state: 'success' | 'failed';
  transfers: MirrorNodeTransfer[];
  /** Decoded from `memo_base64`; `''` when the transaction carried no memo. */
  memo: string;
};

/** 1 HBAR = 100,000,000 tinybars. */
export const TINYBARS_PER_HBAR = 100_000_000;

/**
 * Converts an SDK-format transaction id ("0.0.1234@1690000000.123456789") to
 * the mirror node REST id ("0.0.1234-1690000000-123456789"): the '@' and the
 * '.' that separates seconds from nanos both become '-'. The dots inside the
 * account id ("0.0.1234") are left alone.
 */
export function toMirrorNodeTransactionId(txId: string): string {
  const at = txId.indexOf('@');
  if (at === -1) {
    throw new Error(`not a Hedera SDK transaction id (missing '@'): ${txId}`);
  }
  const accountId = txId.slice(0, at);
  const timestamp = txId.slice(at + 1);
  const dot = timestamp.indexOf('.');
  if (dot === -1) {
    throw new Error(`not a Hedera SDK transaction id (missing seconds.nanos): ${txId}`);
  }
  return `${accountId}-${timestamp.slice(0, dot)}-${timestamp.slice(dot + 1)}`;
}

/**
 * Polls the mirror node for `txId` until it is final or `timeoutMs` elapses,
 * resolving the full transaction detail (state, transfers, memo). Rejects
 * with `MirrorNodeTimeoutError` when the mirror node never surfaces the
 * transaction (a 404, i.e. "pending") within the timeout. `pollMirrorNode`
 * (below) is a thin boolean-only wrapper over this for callers that only ever
 * needed the SUCCESS/failed distinction; `createHederaPaymentsPort`'s
 * `confirmPayment` (see ../payments.ts) is the caller that needs the rest —
 * it checks a payment's actual amount, recipient, and memo before treating it
 * as having paid for anything (issue: hedera-F1, payment-gating used to check
 * only SUCCESS/failure).
 */
export async function pollMirrorNodeTransaction(
  txId: string,
  config: MirrorNodePollConfig,
): Promise<MirrorNodeTransactionDetail> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = config.sleepImpl ?? defaultSleep;
  const url = `${config.baseUrl.replace(/\/+$/, '')}/api/v1/transactions/${toMirrorNodeTransactionId(txId)}`;

  const start = Date.now();
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const res = await config.fetchImpl(url);

    if (res.status === 200) {
      const body = (await res.json()) as MirrorNodeTransactionsResponse;
      const tx = body.transactions?.[0];
      if (tx) {
        const state: MirrorNodePollState = tx.result === 'SUCCESS' ? 'success' : 'failed';
        config.onAttempt?.({ attempt, elapsedMs: Date.now() - start, state });
        const transfers: MirrorNodeTransfer[] = (tx.transfers ?? []).map((t) => ({
          accountId: t.account,
          amountTinybars: t.amount,
        }));
        const memo = tx.memo_base64 ? Buffer.from(tx.memo_base64, 'base64').toString('utf8') : '';
        return { state: state === 'success' ? 'success' : 'failed', transfers, memo };
      }
    }

    const elapsedMs = Date.now() - start;
    config.onAttempt?.({ attempt, elapsedMs, state: 'pending' });

    if (elapsedMs >= timeoutMs) {
      throw new MirrorNodeTimeoutError(txId, timeoutMs);
    }
    await sleep(intervalMs);
  }
}

/**
 * Polls the mirror node for `txId` until it is final or `timeoutMs` elapses.
 *
 * Resolves `true` when the mirror node reports `result: "SUCCESS"`, `false`
 * when it reports any other final result (the tx landed but failed), and
 * rejects with `MirrorNodeTimeoutError` when the mirror node never surfaces
 * the transaction (a 404, i.e. "pending") within the timeout.
 */
export async function pollMirrorNode(txId: string, config: MirrorNodePollConfig): Promise<boolean> {
  const detail = await pollMirrorNodeTransaction(txId, config);
  return detail.state === 'success';
}

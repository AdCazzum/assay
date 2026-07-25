/**
 * Wraps a `PaymentsPort` so the watchdog can report the exact slash
 * transaction it triggered (bondRef, recipient, txId), without touching
 * `@assay/core`.
 *
 * `AssayNode.settle()` (packages/core/src/node.ts) calls `payments.slash(...)`
 * itself, internally, and returns only the updated `Job` — no txId. That is
 * fine for the rail (the job doesn't need to remember it), but a viewer of
 * this demo does want the one thing the loop actually cares to check: the
 * HashScan link for the slash. Rather than adding a return value to core's
 * `settle()` (out of scope for `apps/watchdog`, and shared by `apps/mcp` too),
 * this observes the same `PaymentsPort` instance at the one seam it already
 * crosses.
 */

import type { PaymentsPort } from '@assay/core';

export type SlashRecord = {
  bondRef: string;
  toChallenger: string;
  txId: string;
};

export type ObservedPayments = {
  /** The same `PaymentsPort`, transparently delegating every call, with `slash()` also recorded. */
  payments: PaymentsPort;
  /** The most recent `slash()` call this wrapper saw, if any. */
  getLastSlash: () => SlashRecord | undefined;
};

/** Decorates `payments` so every `slash()` call is recorded and retrievable, without changing its behavior. */
export function observeSlash(payments: PaymentsPort): ObservedPayments {
  let last: SlashRecord | undefined;

  return {
    payments: {
      pay: (amountHbar, requestHash) => payments.pay(amountHbar, requestHash),
      confirm: (txId) => payments.confirm(txId),
      // Forwarded conditionally because `confirmPayment` is optional on the
      // port. Omitting it would silently downgrade the watchdog to the weaker
      // SUCCESS-only gate: `serve()` falls back to `confirm()` when the method
      // is absent, so a wrapper that quietly drops it turns a real check into
      // no check, with nothing failing to show it.
      ...(payments.confirmPayment
        ? { confirmPayment: (input: Parameters<NonNullable<PaymentsPort['confirmPayment']>>[0]) => payments.confirmPayment!(input) }
        : {}),
      postBond: (amountHbar) => payments.postBond(amountHbar),
      async slash(bondRef, toChallenger) {
        const result = await payments.slash(bondRef, toChallenger);
        last = { bondRef, toChallenger, txId: result.txId };
        return result;
      },
    },
    getLastSlash: () => last,
  };
}

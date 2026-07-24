/**
 * A bare `Promise.race` timeout helper, used to bound how long
 * `ProviderService` waits on `AssayNode#serve()` (see `service.ts`).
 *
 * Why this lives here and not only "on the requester" (SPEC.md §12 puts
 * timeout handling requester-side): `serve()` starts by awaiting
 * `payments.confirm(txId)` (see `@assay/core`'s `node.ts`), and nothing in
 * `PaymentsPort`'s contract promises that call ever settles. The real Hedera
 * adapter bounds its own poll (`pollMirrorNode`'s `timeoutMs`, default 15s),
 * but that is an adapter-level guarantee, not one the `PaymentsPort`
 * interface itself makes — a slow or misbehaving port could hang `serve()`
 * forever. This is a defensive, provider-side backstop so this *service*
 * never hangs a caller indefinitely, on top of (not instead of) the
 * requester-side timeout SPEC.md calls for.
 */

/**
 * Races `promise` against a timer. Resolves/rejects with whichever settles
 * first; if the timer wins, rejects with `onTimeout()`. The timer is
 * `unref()`d and always cleared, so it never keeps the process alive by
 * itself, even if `promise` never settles.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
    timer.unref?.();
  });

  return Promise.race([promise, timedOut]).finally(() => {
    clearTimeout(timer);
  });
}

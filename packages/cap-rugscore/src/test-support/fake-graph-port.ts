import type { GraphPort, TokenSignals } from '@assay/core';

/**
 * Test double for `GraphPort`. This is NOT the real Graph adapter (that is
 * `@assay/graph`, built in a sibling issue against the same interface): it
 * returns pre-programmed signals instead of querying The Graph Token API, so
 * `run()`/`verify()` can be unit tested without live credentials or a
 * network call. Named obviously as a fake so it is never mistaken for the
 * sponsor integration.
 */

/**
 * Either a fixed `TokenSignals` row, or a function of the requested
 * `atBlock` — the latter lets a test express "this token's real signals
 * differ depending on which block you ask for", which is exactly what
 * proves a caller queried the right block rather than always getting away
 * with querying the current head (see `verify.test.ts`'s "not slashed when
 * the chain moves" case).
 */
export type FakeTokenSignals = TokenSignals | ((atBlock?: number) => TokenSignals);

export class FakeGraphPort implements GraphPort {
  /** Every `getTokenSignals` call this fake received, in order. */
  readonly calls: Array<{ token: string; atBlock?: number }> = [];
  /** How many times `getLatestBlock()` was called. `verify()` must never call it: see the "chain moves" test. */
  getLatestBlockCallCount = 0;

  constructor(
    private latestBlock: number,
    private readonly signalsByToken: Record<string, FakeTokenSignals>,
  ) {}

  /** Simulates the chain head advancing after a job was served, independent of any already-served claim's `atBlock`. */
  setLatestBlock(block: number): void {
    this.latestBlock = block;
  }

  async getLatestBlock(): Promise<number> {
    this.getLatestBlockCallCount += 1;
    return this.latestBlock;
  }

  async getTokenSignals(token: string, atBlock?: number): Promise<TokenSignals> {
    this.calls.push({ token, atBlock });
    const entry = this.signalsByToken[token];
    if (!entry) {
      throw new Error(`FakeGraphPort: no fixture registered for token "${token}"`);
    }
    return typeof entry === 'function' ? entry(atBlock) : entry;
  }
}

/**
 * A `GraphPort` whose `getTokenSignals` always rejects, obviously named as a
 * test double for the "the port cannot answer" paths `verify()` must treat
 * as "cannot verify", never as "verified false" (SPEC.md §12).
 */
export class FailingGraphPort implements GraphPort {
  constructor(private readonly error: Error) {}

  async getLatestBlock(): Promise<number> {
    throw this.error;
  }

  async getTokenSignals(): Promise<TokenSignals> {
    throw this.error;
  }
}

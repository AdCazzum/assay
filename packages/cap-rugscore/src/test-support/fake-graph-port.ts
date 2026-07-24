import type { GraphPort, TokenSignals } from '@assay/core';

/**
 * Test double for `GraphPort`. This is NOT the real Graph adapter (that is
 * `@assay/graph`, built in a sibling issue against the same interface): it
 * returns pre-programmed signals instead of querying The Graph Token API, so
 * `run()` can be unit tested without live credentials or a network call.
 * Named obviously as a fake so it is never mistaken for the sponsor
 * integration.
 */
export class FakeGraphPort implements GraphPort {
  /** Every `getTokenSignals` call this fake received, in order. */
  readonly calls: Array<{ token: string; atBlock?: number }> = [];

  constructor(
    private readonly latestBlock: number,
    private readonly signalsByToken: Record<string, TokenSignals>,
  ) {}

  async getLatestBlock(): Promise<number> {
    return this.latestBlock;
  }

  async getTokenSignals(token: string, atBlock?: number): Promise<TokenSignals> {
    this.calls.push({ token, atBlock });
    const signals = this.signalsByToken[token];
    if (!signals) {
      throw new Error(`FakeGraphPort: no fixture registered for token "${token}"`);
    }
    return signals;
  }
}

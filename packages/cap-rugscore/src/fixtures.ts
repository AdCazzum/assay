import type { TokenSignals } from '@assay/core';

/**
 * The two token fixtures SPEC.md §13 asks the verifier's unit tests to cover:
 * one "clean" token, one "rug" token. Values here are illustrative, shaped
 * around what real mainnet tokens measured live for #49 look like (see
 * `packages/graph/README.md` "the thin/sketchy contrast, live and real" —
 * a real thin token held single-digit `txCount`, sub-$1 top-pool liquidity,
 * and near-total pool concentration; USDC held tens of millions of
 * `txCount`, hundreds of millions in its deepest pool alone, and its
 * liquidity spread such that no single pool held more than half of even a
 * 5-pool sample), not live-queried data itself (the real query path is
 * `scripts/smoke.ts`, exercised once @assay/graph's adapter and
 * `GRAPH_API_KEY` are both in place).
 *
 * `atBlock` is omitted here because it belongs to the query, not the fixture:
 * a `FakeGraphPort` stamps it per-call. See `test-support/fake-graph-port.ts`.
 */
export type FixtureSignals = Omit<TokenSignals, 'atBlock'>;

export const CLEAN_TOKEN_SIGNALS: FixtureSignals = {
  liquidityUsd: 4_800_000,
  ageBlocks: 1_500_000,
  txCount: 5_000_000,
  volumeUsd: 900_000_000,
  topPoolConcentrationPct: 25,
};

export const RUG_TOKEN_SIGNALS: FixtureSignals = {
  liquidityUsd: 900,
  ageBlocks: 50,
  txCount: 8,
  volumeUsd: 400,
  topPoolConcentrationPct: 98,
};

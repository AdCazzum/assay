import type { TokenSignals } from '@assay/core';

/**
 * The two token fixtures SPEC.md §13 asks the verifier's unit tests to cover:
 * one "clean" token, one "rug" token. Values here are illustrative signals
 * shaped like what The Graph Token API would return, not live on-chain data
 * (the real query path is `scripts/smoke.ts`, exercised once @assay/graph's
 * adapter and GRAPH_API_KEY are both in place).
 *
 * `atBlock` is omitted here because it belongs to the query, not the fixture:
 * a `FakeGraphPort` stamps it per-call. See `test-support/fake-graph-port.ts`.
 */
export type FixtureSignals = Omit<TokenSignals, 'atBlock'>;

export const CLEAN_TOKEN_SIGNALS: FixtureSignals = {
  holders: 42_000,
  top10Pct: 12,
  liquidityUsd: 4_800_000,
  ageBlocks: 1_500_000,
  transfers: 980_000,
  hasActiveMintRole: false,
};

export const RUG_TOKEN_SIGNALS: FixtureSignals = {
  holders: 340,
  top10Pct: 91,
  liquidityUsd: 900,
  ageBlocks: 50,
  transfers: 120,
  hasActiveMintRole: true,
};

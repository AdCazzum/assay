import type { Capability, Claim } from '@assay/core';
import type { GraphPort } from '@assay/core';
import { scoreRugPullRisk } from './scoring.js';

export type RugScoreRequest = string;
export type RugScoreResult = { score: number };

export type RugScoreDeps = {
  /**
   * Injected by interface only (SPEC.md §4, §6). This package depends on the
   * `GraphPort` contract from `@assay/core`, never on `@assay/graph`'s
   * internals, so it can be built and tested without waiting on the sibling
   * issue implementing the real adapter.
   */
  graph: GraphPort;
};

/**
 * The rug-score capability: `run(token)` fetches signals for a token at one
 * block and aggregates them into a risk score plus factual claims, each
 * stamped with that same block (SPEC.md §6, §12).
 *
 * `verify()` re-deriving and comparing claims is issue #12; it throws here
 * rather than returning a fake `{valid: true}`, which would silently pass
 * tests and defeat the whole point of the verifier.
 */
export function createRugScoreCapability({ graph }: RugScoreDeps): Capability<
  RugScoreRequest,
  RugScoreResult
> {
  return {
    id: 'rugscore',

    async run(token: RugScoreRequest) {
      // One block for the whole run: get it once, then fetch signals at
      // exactly that block. Two separate "current block" reads here would
      // risk the head moving between them, drifting the claims apart.
      const atBlock = await graph.getLatestBlock();
      const signals = await graph.getTokenSignals(token, atBlock);

      const { score, claims } = scoreRugPullRisk(signals);

      // Stamp with `signals.atBlock` (the block the data actually came from),
      // not the `atBlock` we requested: if the port ever serves data for a
      // different block than asked, the claim must say so honestly, or the
      // verifier re-querying at a stamped-but-wrong block would slash an
      // honest provider on plain data drift (SPEC.md §12).
      const stampedClaims: Claim[] = claims.map((claim) => ({
        ...claim,
        atBlock: signals.atBlock,
      }));

      return { result: { score }, claims: stampedClaims };
    },

    async verify() {
      throw new Error('verify is tracked in #12');
    },
  };
}

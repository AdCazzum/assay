import type { Capability, Claim, Verdict } from '@assay/core';
import type { GraphPort, TokenSignals } from '@assay/core';
import { scoreRugPullRisk, type RugScoreSignals } from './scoring.js';
import { ClaimVerificationUnavailableError } from './errors.js';
import { DEFAULT_RUGSCORE_TOLERANCES, withinTolerance, type RugScoreTolerances } from './tolerances.js';

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
  /**
   * Per-signal comparison tolerances `verify()` uses when re-deriving each
   * claim (SPEC.md §12). Overrides are merged over `DEFAULT_RUGSCORE_TOLERANCES`
   * one field at a time, so tuning one signal (e.g. after observing real
   * gateway noise) never requires restating the rest. See `tolerances.ts` for
   * the reasoning behind each default.
   */
  tolerances?: Partial<RugScoreTolerances>;
};

const RUG_SCORE_SIGNAL_KEYS = [
  'liquidityUsd',
  'ageBlocks',
  'txCount',
  'volumeUsd',
  'topPoolConcentrationPct',
] as const;

function isRugScoreSignalKey(k: string): k is keyof RugScoreSignals {
  return (RUG_SCORE_SIGNAL_KEYS as readonly string[]).includes(k);
}

/**
 * Compares one claim against the freshly re-derived signals for its block.
 * Returns `'unknown'` when this verifier has no way to judge the claim at
 * all (SPEC.md §12: a claim whose signal this capability doesn't recognize
 * is not evidence of a lie), rather than folding that case into `false`.
 */
function claimMatches(claim: Claim, signals: TokenSignals, tolerances: RugScoreTolerances): boolean | 'unknown' {
  if (!isRugScoreSignalKey(claim.k)) return 'unknown';
  if (typeof claim.v !== 'number') return false;
  return withinTolerance(claim.v, signals[claim.k], tolerances[claim.k]);
}

/**
 * The rug-score capability: `run(token)` fetches signals for a token at one
 * block and aggregates them into a risk score plus factual claims, each
 * stamped with that same block (SPEC.md §6, §12).
 *
 * `verify(req, result, claims)` re-derives each claim from the same
 * `GraphPort`, but at the claim's *own* `atBlock`, never the current head
 * (SPEC.md §12 — the single most important line in this file: verifying
 * against live data would slash an honest provider the instant the chain
 * moves). It returns the first claim that fails as `badClaim`, or
 * `{valid: true}` when every claim holds up. A claim this capability cannot
 * judge at all (an unrecognized key, or the port failing to answer at that
 * block) rejects with `ClaimVerificationUnavailableError` instead of
 * folding into either verdict: "we could not check" must never be read as
 * "we checked and it's false" by a caller with real money on the line.
 */
export function createRugScoreCapability({ graph, tolerances }: RugScoreDeps): Capability<
  RugScoreRequest,
  RugScoreResult
> {
  const effectiveTolerances: RugScoreTolerances = {
    ...DEFAULT_RUGSCORE_TOLERANCES,
    ...tolerances,
  };

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

    async verify(token: RugScoreRequest, _result: RugScoreResult, claims: Claim[]): Promise<Verdict> {
      // Cache re-derived signals per distinct atBlock: every rugscore claim
      // shares one atBlock in practice (see run() above), so this keeps
      // verifying an honest job to one query, not one per claim — the same
      // "verifying a claim is cheap" property SPEC.md §3 and §6 depend on.
      // Nothing here *assumes* a single block, though: a claim set spanning
      // several blocks is still verified correctly, each at its own block.
      const signalsByBlock = new Map<number, TokenSignals>();

      for (const claim of claims) {
        let signals = signalsByBlock.get(claim.atBlock);
        if (!signals) {
          try {
            // The claim's own atBlock, never `graph.getLatestBlock()`.
            signals = await graph.getTokenSignals(token, claim.atBlock);
          } catch (cause) {
            throw new ClaimVerificationUnavailableError(claim.k, claim.atBlock, cause);
          }
          signalsByBlock.set(claim.atBlock, signals);
        }

        const matches = claimMatches(claim, signals, effectiveTolerances);
        if (matches === 'unknown') {
          throw new ClaimVerificationUnavailableError(
            claim.k,
            claim.atBlock,
            new Error(`"${claim.k}" is not a signal this verifier knows how to re-derive`),
          );
        }
        if (!matches) {
          return {
            valid: false,
            badClaim: claim.k,
            reason: `claimed ${claim.k}=${JSON.stringify(claim.v)} at block ${claim.atBlock}, but The Graph reports ${JSON.stringify(
              (signals as Record<string, unknown>)[claim.k],
            )}`,
          };
        }
      }

      return { valid: true };
    },
  };
}

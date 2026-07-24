/**
 * The reputation math `settle()` applies once a verdict is in (SPEC.md §7
 * step 7, §9). Pulled out of `node.ts` the same way `pay-policy.ts` pulled
 * the pay/decline floor out of `payAndCall`: pure, tunable, and unit-testable
 * on its own.
 *
 * Two outcomes, both real reputation writes (never just the slash side):
 *
 *  - **Invalid verdict** (the provider lied): `score` drops, `slashes` and
 *    `jobs` both go up. This is the demo climax's aftermath.
 *  - **Valid verdict** (the challenge failed): `score` rises and `jobs` goes
 *    up, `slashes` untouched. SPEC.md §7 step 7 is explicit that a failed
 *    challenge is not a no-op: "il challenge fallisce -> il challenger perde
 *    il deposito, reputazione ↑" for the provider. This module only computes
 *    the provider-reputation half of that sentence. The challenger-deposit
 *    half is deliberately NOT implemented anywhere in `settle()`: `PaymentsPort`
 *    has no operation that ever takes a deposit from a challenger in the
 *    first place (`challenge()` never calls `payments.pay`/`postBond` for the
 *    challenger), so there is no real escrow to forfeit. Inventing a transfer
 *    here to act out "loses its deposit" would be exactly the faked
 *    integration AGENTS.md rules out. Flagged honestly rather than papered
 *    over; a real challenger bond is follow-up work, not part of #27.
 *
 * `jobs` is incremented on both outcomes (mirroring how `apps/mcp`'s `rate()`
 * already increments it for the non-adversarial close-out path): the
 * reputation's `jobs` counter means "jobs closed out", and a settled job is
 * closed out precisely at this step, not at `serve()` time.
 */

import type { Reputation } from './types.js';

export type SettlementPolicyConfig = {
  /** Flat `score` penalty applied when a claim is proven false. Tunable: raise it to make a lie hurt more. */
  slashScorePenalty: number;
  /** Flat `score` bonus applied when a challenge fails (the claim held up). Tunable: deliberately smaller than the penalty — trust is slower to earn than to lose. */
  challengeFailedScoreBonus: number;
  /** `score` never drops below this floor. */
  minScore: number;
  /** `score` never rises above this ceiling. */
  maxScore: number;
};

/**
 * Asymmetric on purpose: losing a proven lie costs far more than winning a
 * challenge earns, which is the whole point of staking reputation on
 * verifiable claims rather than on stars (SPEC.md §3).
 */
export const DEFAULT_SETTLEMENT_POLICY: SettlementPolicyConfig = {
  slashScorePenalty: 30,
  challengeFailedScoreBonus: 5,
  minScore: 0,
  maxScore: 100,
};

function clampScore(score: number, config: SettlementPolicyConfig): number {
  return Math.min(config.maxScore, Math.max(config.minScore, score));
}

/** The reputation delta for a provider caught lying: score down, one more slash, one more closed-out job. */
export function computeSlashReputationDelta(
  current: Reputation,
  config: SettlementPolicyConfig = DEFAULT_SETTLEMENT_POLICY,
): Partial<Reputation> {
  return {
    score: clampScore(current.score - config.slashScorePenalty, config),
    jobs: current.jobs + 1,
    slashes: current.slashes + 1,
  };
}

/** The reputation delta for a provider vindicated by a failed challenge: score up, one more closed-out job, slashes untouched. */
export function computeChallengeFailedReputationDelta(
  current: Reputation,
  config: SettlementPolicyConfig = DEFAULT_SETTLEMENT_POLICY,
): Partial<Reputation> {
  return {
    score: clampScore(current.score + config.challengeFailedScoreBonus, config),
    jobs: current.jobs + 1,
  };
}

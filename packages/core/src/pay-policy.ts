/**
 * The programmatic pay/no-pay floor (SPEC.md §7 step 2, §16 risk 5).
 *
 * `assessment.ts` produces the reasoning material; a real agent reasoning
 * over that material through the MCP `discover` tool (#46) is the actual
 * demo. This module is the fallback for *non-agent* callers of `payAndCall`
 * (and a safety floor even for agent-driven ones): explicit, injectable
 * thresholds that turn a `ProviderAssessment` into pay/decline, so
 * `payAndCall` never pays blindly just because a payment rail exists.
 *
 * The thresholds below are defaults, not gospel: every field on
 * `PayDecisionPolicyConfig` is documented as tunable, and `createAssayNode`
 * accepts an override (see `node.ts`'s `payPolicy` config field).
 */

import type { AssessmentSignal, ProviderAssessment } from './assessment.js';

export type PayDecisionPolicyConfig = {
  /**
   * Decline if `slashRatio` (`slashes / jobs`) exceeds this. Only checked
   * when the provider is not unproven (`jobs > 0`; an unproven provider has
   * `slashRatio === null` and never trips this rule on its own). Tunable:
   * lower it to be stricter about a provider's track record.
   */
  maxSlashRatio: number;
  /**
   * Decline if `bondToPriceRatio` (`bondHbar / priceHbar`) is below this: the
   * bond is too small relative to what is being paid to be meaningful
   * collateral. Tunable: raise it to require a bigger cushion.
   */
  minBondToPriceRatio: number;
};

/**
 * A middling default: not zero-tolerance (a single slash on an otherwise
 * long history should not permanently blacklist a provider), and not so
 * loose that a bond smaller than the price itself still passes.
 */
export const DEFAULT_PAY_DECISION_POLICY: PayDecisionPolicyConfig = {
  maxSlashRatio: 0.15,
  minBondToPriceRatio: 2,
};

export type PayDecision =
  | { pay: true }
  | { pay: false; reason: string; violations: AssessmentSignal[] };

function findSignal(assessment: ProviderAssessment, key: string): AssessmentSignal | undefined {
  return assessment.signals.find((signal) => signal.key === key);
}

/**
 * Applies `config` to `assessment` and returns pay/decline. Pure, like
 * `assessProvider`: same assessment and config in, same decision out.
 */
export function evaluatePayDecision(
  assessment: ProviderAssessment,
  config: PayDecisionPolicyConfig = DEFAULT_PAY_DECISION_POLICY,
): PayDecision {
  const violations: AssessmentSignal[] = [];

  if (assessment.slashRatio !== null && assessment.slashRatio > config.maxSlashRatio) {
    violations.push(
      findSignal(assessment, 'trackRecord') ?? {
        key: 'trackRecord',
        severity: 'concern',
        detail: `Slash ratio ${assessment.slashRatio} exceeds the policy maximum of ${config.maxSlashRatio}.`,
      },
    );
  }

  if (assessment.bondToPriceRatio < config.minBondToPriceRatio) {
    violations.push(
      findSignal(assessment, 'collateral') ?? {
        key: 'collateral',
        severity: 'concern',
        detail: `Bond/price ratio ${assessment.bondToPriceRatio} is below the policy minimum of ${config.minBondToPriceRatio}.`,
      },
    );
  }

  if (violations.length === 0) {
    return { pay: true };
  }

  return {
    pay: false,
    reason: violations.map((violation) => violation.detail).join(' '),
    violations,
  };
}

/**
 * Thrown by `payAndCall` (see `node.ts`) when `evaluatePayDecision` declines.
 * Carries the full `ProviderAssessment` and the specific `violations` that
 * tripped the policy, so a caller (or the dashboard) can narrate exactly why,
 * not just that a decline happened.
 */
export class PayDeclinedError extends Error {
  readonly providerName: string;
  readonly assessment: ProviderAssessment;
  readonly violations: AssessmentSignal[];

  constructor(providerName: string, assessment: ProviderAssessment, reason: string, violations: AssessmentSignal[]) {
    super(`Declining to pay "${providerName}": ${reason}`);
    this.name = 'PayDeclinedError';
    this.providerName = providerName;
    this.assessment = assessment;
    this.violations = violations;
  }
}

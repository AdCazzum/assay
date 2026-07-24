/**
 * The requester's pay/no-pay *material* (SPEC.md §7 step 2, §16 risk 5).
 *
 * `assessProvider` is deliberately not a decision. SPEC.md §16 names "agentic
 * must be real reasoning, not a hardcoded if" as a headline risk to the whole
 * submission: in the demo a real Claude agent reads the manifest and the
 * reputation (via the MCP `discover` tool, see #46) and decides out loud
 * whether the price is worth it. This module's job is to hand that agent (and
 * `@assay/core/pay-policy`'s floor for programmatic callers, see
 * `pay-policy.ts`) a structured read of the risk, not to collapse it into a
 * verdict itself.
 *
 * Pure function: no I/O, no adapter, no clock. Same `ProviderRecord` in, same
 * `ProviderAssessment` out, every time.
 */

import type { ProviderRecord } from './types.js';

/**
 * How strongly a signal argues against paying. Intentionally not a single
 * boolean flag: an agent reading `signals` needs to weigh a `concern` more
 * heavily than a `caution`, and `info` signals (like the raw ENS score) still
 * belong in the read even when they do not argue either way.
 */
export type SignalSeverity = 'info' | 'caution' | 'concern';

/** One piece of reasoning material: which signal fired, how strongly, and why. */
export type AssessmentSignal = {
  /** Stable identifier for this signal, so a policy (or an agent) can key off it: `'trackRecord' | 'collateral' | 'score'`. */
  key: string;
  severity: SignalSeverity;
  /** Human-readable, meant to be read out loud by the agent in the demo. */
  detail: string;
};

/**
 * The structured read of a provider's risk. Every field an agent (or a
 * policy) could plausibly want is here as data, not folded into a verdict:
 * `unproven`/`slashRatio` in particular are kept separate on purpose (see
 * `assessProvider`'s doc comment) so "no track record" is never confused with
 * "good track record".
 */
export type ProviderAssessment = {
  providerName: string;
  /** The price this assessment is weighed against: `opts.priceHbar`, or the manifest's price if not given. */
  priceHbar: number;
  jobs: number;
  slashes: number;
  /**
   * `slashes / jobs`. `null` when `jobs === 0`: a 0/0 ratio would read as
   * "0, i.e. spotless", which is exactly the false-good conflation SPEC.md
   * §16 risk 5 warns about. Consult `unproven` instead for that case.
   */
  slashRatio: number | null;
  /** `true` iff `jobs === 0`. An unproven provider is not "good", it is unscored: distinguish the two. */
  unproven: boolean;
  bondHbar: number;
  /** `bondHbar / priceHbar`. How many calls' worth of price the bond could cover if this one is slashed. */
  bondToPriceRatio: number;
  /** The raw ENS reputation score, carried through for completeness. Weighed lightly: see `signals` for why slash ratio and job count matter more. */
  score: number;
  /** The reasoning material itself, most information-bearing first: track record, then collateral, then the raw score. */
  signals: AssessmentSignal[];
};

export type AssessProviderOptions = {
  /**
   * Overrides `provider.manifest.priceHbar`. Lets a caller assess a provider
   * against the price a specific call would actually cost, when that differs
   * from the manifest's listed default.
   */
  priceHbar?: number;
};

/** Below this slash ratio the record reads as clean; at/above it starts to look bad enough to call out as a concern rather than a caution. Purely descriptive, not a decision threshold: see `pay-policy.ts`'s `DEFAULT_PAY_DECISION_POLICY` for the tunable used to actually decline. */
const CONCERNING_SLASH_RATIO = 0.2;

/** Below this bond/price ratio the collateral reads as outright weak; below the next one it reads as merely adequate. Same caveat as above: descriptive, not the decision floor. */
const WEAK_BOND_RATIO = 2;
const ADEQUATE_BOND_RATIO = 5;

function assessTrackRecord(jobs: number, slashes: number, slashRatio: number | null): AssessmentSignal {
  if (slashRatio === null) {
    return {
      key: 'trackRecord',
      severity: 'caution',
      detail:
        'This provider has served 0 jobs: there is no track record yet. Unproven is not the same as good; weigh the bond and the raw score more heavily than usual.',
    };
  }

  if (slashes === 0) {
    return {
      key: 'trackRecord',
      severity: 'info',
      detail: `Clean record: 0 slashes across ${jobs} job(s).`,
    };
  }

  const severity: SignalSeverity = slashRatio >= CONCERNING_SLASH_RATIO ? 'concern' : 'caution';
  const pct = (slashRatio * 100).toFixed(1);
  return {
    key: 'trackRecord',
    severity,
    detail: `${slashes} of ${jobs} job(s) were slashed (${pct}% slash ratio). The slash ratio matters more than the raw score.`,
  };
}

function assessCollateral(bondHbar: number, priceHbar: number, bondToPriceRatio: number): AssessmentSignal {
  if (bondToPriceRatio < WEAK_BOND_RATIO) {
    return {
      key: 'collateral',
      severity: 'concern',
      detail: `Bond (${bondHbar} HBAR) is only ${bondToPriceRatio.toFixed(2)}x the price (${priceHbar} HBAR): weak collateral if this provider lies.`,
    };
  }
  if (bondToPriceRatio < ADEQUATE_BOND_RATIO) {
    return {
      key: 'collateral',
      severity: 'caution',
      detail: `Bond (${bondHbar} HBAR) is ${bondToPriceRatio.toFixed(2)}x the price (${priceHbar} HBAR): adequate but not generous collateral.`,
    };
  }
  return {
    key: 'collateral',
    severity: 'info',
    detail: `Bond (${bondHbar} HBAR) is ${bondToPriceRatio.toFixed(2)}x the price (${priceHbar} HBAR): strong collateral.`,
  };
}

/**
 * Reads a provider's risk out of its `ProviderRecord`. Pure: no network call,
 * no clock, no randomness. See the module doc comment for why this stops at
 * a structured read rather than a pay/decline verdict.
 */
export function assessProvider(
  provider: ProviderRecord,
  opts: AssessProviderOptions = {},
): ProviderAssessment {
  const { name, manifest, reputation } = provider;
  const priceHbar = opts.priceHbar ?? manifest.priceHbar;
  const { jobs, slashes, bondHbar, score } = reputation;

  const unproven = jobs === 0;
  const slashRatio = unproven ? null : slashes / jobs;
  const bondToPriceRatio = priceHbar > 0 ? bondHbar / priceHbar : Number.POSITIVE_INFINITY;

  const signals: AssessmentSignal[] = [
    assessTrackRecord(jobs, slashes, slashRatio),
    assessCollateral(bondHbar, priceHbar, bondToPriceRatio),
    {
      key: 'score',
      severity: 'info',
      detail: `Raw reputation score is ${score}. Treat it as a minor signal next to the slash ratio and job count above.`,
    },
  ];

  return {
    providerName: name,
    priceHbar,
    jobs,
    slashes,
    slashRatio,
    unproven,
    bondHbar,
    bondToPriceRatio,
    score,
    signals,
  };
}

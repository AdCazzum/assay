import { describe, expect, it } from 'vitest';
import { assessProvider } from './assessment.js';
import { DEFAULT_PAY_DECISION_POLICY, evaluatePayDecision, PayDeclinedError } from './pay-policy.js';
import type { ProviderRecord } from './types.js';

function makeRecord(reputation: Partial<ProviderRecord['reputation']> = {}, priceHbar = 5): ProviderRecord {
  return {
    name: 'rugscore.assay.eth',
    manifest: {
      capabilityId: 'rugscore',
      description: 'rug-pull risk score for an ERC-20 token',
      priceHbar,
      endpoint: 'https://example.invalid/rugscore',
      bondRef: 'bond-1',
      verifierHash: '0xverifierhash',
    },
    reputation: { score: 80, jobs: 20, slashes: 0, bondHbar: 50, ...reputation },
  };
}

describe('evaluatePayDecision', () => {
  it('pays a provider with a clean record and a bond that comfortably covers the price', () => {
    const assessment = assessProvider(makeRecord({ jobs: 20, slashes: 0, bondHbar: 50 }, 5));

    const decision = evaluatePayDecision(assessment);

    expect(decision).toEqual({ pay: true });
  });

  it('declines a provider with slashes against few jobs, and says why', () => {
    const assessment = assessProvider(makeRecord({ jobs: 4, slashes: 1, bondHbar: 50 }, 5));

    const decision = evaluatePayDecision(assessment);

    expect(decision.pay).toBe(false);
    if (decision.pay) throw new Error('expected a decline');
    expect(decision.reason).toMatch(/slash/i);
    expect(decision.violations.some((v) => v.key === 'trackRecord')).toBe(true);
  });

  it('declines a provider whose bond is far smaller than the price', () => {
    const assessment = assessProvider(makeRecord({ jobs: 20, slashes: 0, bondHbar: 2 }, 100));

    const decision = evaluatePayDecision(assessment);

    expect(decision.pay).toBe(false);
    if (decision.pay) throw new Error('expected a decline');
    expect(decision.reason).toMatch(/bond/i);
    expect(decision.violations.some((v) => v.key === 'collateral')).toBe(true);
  });

  it('does not automatically decline an unproven (0-job) provider on track record alone, given a strong bond', () => {
    const assessment = assessProvider(makeRecord({ jobs: 0, slashes: 0, bondHbar: 50 }, 5));

    const decision = evaluatePayDecision(assessment);

    // the assessment still marks it unproven (see assessment.test.ts); the
    // *policy* floor only trips on slash ratio and collateral, not on job
    // count alone, so a fresh, well-bonded provider is not blocked from ever
    // getting a first job.
    expect(assessment.unproven).toBe(true);
    expect(decision).toEqual({ pay: true });
  });

  it('respects an injected, stricter policy config', () => {
    const assessment = assessProvider(makeRecord({ jobs: 100, slashes: 1, bondHbar: 50 }, 5));
    // slash ratio 0.01, below the default 0.15 threshold: passes by default
    expect(evaluatePayDecision(assessment)).toEqual({ pay: true });

    // but a caller can inject a stricter floor
    const strict = { ...DEFAULT_PAY_DECISION_POLICY, maxSlashRatio: 0.005 };
    const decision = evaluatePayDecision(assessment, strict);
    expect(decision.pay).toBe(false);
  });
});

describe('PayDeclinedError', () => {
  it('names the provider and carries the assessment and violations for the caller to inspect', () => {
    const assessment = assessProvider(makeRecord({ jobs: 4, slashes: 2, bondHbar: 50 }, 5));
    const decision = evaluatePayDecision(assessment);
    if (decision.pay) throw new Error('expected a decline');

    const error = new PayDeclinedError('rugscore.assay.eth', assessment, decision.reason, decision.violations);

    expect(error.name).toBe('PayDeclinedError');
    expect(error.providerName).toBe('rugscore.assay.eth');
    expect(error.message).toContain('rugscore.assay.eth');
    expect(error.assessment).toBe(assessment);
    expect(error.violations).toEqual(decision.violations);
  });
});

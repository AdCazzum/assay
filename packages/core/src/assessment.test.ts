import { describe, expect, it } from 'vitest';
import { assessProvider } from './assessment.js';
import type { ProviderRecord } from './types.js';

function makeRecord(overrides: Partial<ProviderRecord['reputation']> & { priceHbar?: number } = {}): ProviderRecord {
  const { priceHbar, ...reputationOverrides } = overrides;
  return {
    name: 'rugscore.assay.eth',
    manifest: {
      capabilityId: 'rugscore',
      description: 'rug-pull risk score for an ERC-20 token',
      priceHbar: priceHbar ?? 5,
      endpoint: 'https://example.invalid/rugscore',
      bondRef: 'bond-1',
      verifierHash: '0xverifierhash',
    },
    reputation: {
      score: 80,
      jobs: 20,
      slashes: 0,
      bondHbar: 50,
      ...reputationOverrides,
    },
  };
}

describe('assessProvider', () => {
  it('is pure: the same record produces deep-equal output on every call', () => {
    const record = makeRecord({ jobs: 12, slashes: 1, bondHbar: 30 });

    const first = assessProvider(record);
    const second = assessProvider(record);

    expect(second).toEqual(first);
  });

  it('reads a clean record as unproven=false with a null-free slash ratio of 0', () => {
    const record = makeRecord({ jobs: 20, slashes: 0 });

    const assessment = assessProvider(record);

    expect(assessment.unproven).toBe(false);
    expect(assessment.slashRatio).toBe(0);
    const trackRecord = assessment.signals.find((s) => s.key === 'trackRecord');
    expect(trackRecord?.severity).toBe('info');
  });

  it('distinguishes an unproven (0-job) provider from a good one, instead of treating it as good', () => {
    const unproven = assessProvider(makeRecord({ jobs: 0, slashes: 0, score: 0 }));
    const good = assessProvider(makeRecord({ jobs: 20, slashes: 0, score: 80 }));

    expect(unproven.unproven).toBe(true);
    expect(unproven.slashRatio).toBeNull(); // not 0: 0/0 must not read as "clean"
    expect(good.unproven).toBe(false);
    expect(good.slashRatio).toBe(0);

    const unprovenSignal = unproven.signals.find((s) => s.key === 'trackRecord');
    const goodSignal = good.signals.find((s) => s.key === 'trackRecord');
    expect(unprovenSignal?.severity).toBe('caution');
    expect(goodSignal?.severity).toBe('info');
    expect(unprovenSignal?.detail).not.toEqual(goodSignal?.detail);
  });

  it('weighs slash ratio over raw score: a provider with slashes against few jobs reads as concerning', () => {
    const assessment = assessProvider(makeRecord({ jobs: 4, slashes: 1, score: 60 }));

    expect(assessment.slashRatio).toBeCloseTo(0.25);
    const trackRecord = assessment.signals.find((s) => s.key === 'trackRecord');
    expect(trackRecord?.severity).toBe('concern');
  });

  it('flags a bond far smaller than the price as weak collateral', () => {
    const assessment = assessProvider(makeRecord({ bondHbar: 2, priceHbar: 100 }));

    expect(assessment.bondToPriceRatio).toBeLessThan(1);
    const collateral = assessment.signals.find((s) => s.key === 'collateral');
    expect(collateral?.severity).toBe('concern');
  });

  it('reads a bond well above the price as strong collateral', () => {
    const assessment = assessProvider(makeRecord({ bondHbar: 500 }));

    expect(assessment.bondToPriceRatio).toBeGreaterThan(5);
    const collateral = assessment.signals.find((s) => s.key === 'collateral');
    expect(collateral?.severity).toBe('info');
  });

  it('lets a caller assess against a call-specific price via opts, overriding the manifest default', () => {
    const record = makeRecord({ bondHbar: 10 });

    const assessment = assessProvider(record, { priceHbar: 20 });

    expect(assessment.priceHbar).toBe(20);
    expect(assessment.bondToPriceRatio).toBe(0.5);
  });
});

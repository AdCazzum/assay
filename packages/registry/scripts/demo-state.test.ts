import { describe, expect, it } from 'vitest';
import {
  assessProvider,
  evaluatePayDecision,
  DEFAULT_PAY_DECISION_POLICY,
  type Manifest,
  type ProviderRecord,
} from '@assay/core';
import {
  DEFAULT_DEMO_BOND_MULTIPLE,
  DEMO_JOBS,
  DEMO_SCORE,
  DEMO_SLASHES,
  buildDemoReputation,
  computeDemoBondHbar,
} from './demo-state.js';

const PRICE_HBAR = 5;

/** A `ProviderRecord` carrying `reputation`, otherwise identical to the real published manifest (issue #64's target: `rugscore.assay.eth` at a 5 HBAR price). */
function providerRecordWith(reputation: ReturnType<typeof buildDemoReputation>): ProviderRecord {
  const manifest: Manifest = {
    capabilityId: 'rugscore',
    description: 'rug-pull risk score for an ERC-20 token',
    priceHbar: PRICE_HBAR,
    endpoint: 'https://provider.example/rugscore',
    bondRef: 'bond-x',
    verifierHash: '0xhash',
  };
  return { name: 'rugscore.assay.eth', manifest, reputation };
}

describe('computeDemoBondHbar', () => {
  it('scales with the live price at a fixed multiple, rather than a hardcoded absolute', () => {
    expect(computeDemoBondHbar(PRICE_HBAR)).toBe(PRICE_HBAR * DEFAULT_DEMO_BOND_MULTIPLE);
    expect(computeDemoBondHbar(10)).toBe(60);
    expect(computeDemoBondHbar(2.5, 4)).toBe(10);
  });

  it('rounds to 2dp to avoid float noise landing in the on-chain record', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in floating point; * 6 compounds that.
    expect(computeDemoBondHbar(0.1 + 0.2, 6)).toBe(1.8);
  });
});

describe('buildDemoReputation', () => {
  it('writes the full absolute shape (score, jobs, slashes, bondHbar), not a partial delta', () => {
    expect(buildDemoReputation(PRICE_HBAR)).toEqual({
      score: DEMO_SCORE,
      jobs: DEMO_JOBS,
      slashes: DEMO_SLASHES,
      bondHbar: PRICE_HBAR * DEFAULT_DEMO_BOND_MULTIPLE,
    });
  });

  it('is not "unproven" under @assay/core\'s real assessProvider: jobs clears the 0-job cutoff', () => {
    const assessment = assessProvider(providerRecordWith(buildDemoReputation(PRICE_HBAR)));
    expect(assessment.unproven).toBe(false);
    expect(assessment.slashRatio).toBe(0);
  });

  it('reads as a clean track record and strong collateral in the real assessment signals', () => {
    const assessment = assessProvider(providerRecordWith(buildDemoReputation(PRICE_HBAR)));
    const trackRecord = assessment.signals.find((s) => s.key === 'trackRecord');
    const collateral = assessment.signals.find((s) => s.key === 'collateral');

    expect(trackRecord?.severity).toBe('info');
    expect(trackRecord?.detail).toMatch(/Clean record/);
    expect(collateral?.severity).toBe('info');
    expect(collateral?.detail).toMatch(/strong collateral/);
  });

  it('clears the real DEFAULT_PAY_DECISION_POLICY with margin -- this is what the demo agent actually pays against', () => {
    const assessment = assessProvider(providerRecordWith(buildDemoReputation(PRICE_HBAR)));
    const decision = evaluatePayDecision(assessment, DEFAULT_PAY_DECISION_POLICY);

    expect(decision).toEqual({ pay: true });
    expect(assessment.bondToPriceRatio).toBeGreaterThanOrEqual(DEFAULT_PAY_DECISION_POLICY.minBondToPriceRatio * 2);
  });

  it('would have flagged the actual damaged live record this issue is about', () => {
    // The record this issue describes: {"score":31,"jobs":5,"slashes":2,"bondHbar":0.02} at a 5 HBAR price.
    const damaged = providerRecordWith({ score: 31, jobs: 5, slashes: 2, bondHbar: 0.02 });
    const decision = evaluatePayDecision(assessProvider(damaged), DEFAULT_PAY_DECISION_POLICY);
    expect(decision.pay).toBe(false);
  });
});

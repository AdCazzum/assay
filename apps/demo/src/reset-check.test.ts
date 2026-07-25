import { describe, expect, it } from 'vitest';
import type { AssayNode, ProviderAssessment } from '@assay/core';
import { checkDemoReadiness } from './reset-check.js';

function fakeAssessNode(assessment: ProviderAssessment): Pick<AssayNode, 'assess'> {
  return { assess: async () => assessment };
}

const BASE: ProviderAssessment = {
  providerName: 'rugscore.assay.eth',
  priceHbar: 5,
  jobs: 14,
  slashes: 0,
  slashRatio: 0,
  unproven: false,
  bondHbar: 30,
  bondToPriceRatio: 6,
  score: 78,
  signals: [],
};

describe('checkDemoReadiness', () => {
  it('is ready when the live assessment would pass the pay policy (reset-demo-state.ts having run)', async () => {
    const node = fakeAssessNode(BASE);
    const result = await checkDemoReadiness(node, 'rugscore.assay.eth');
    expect(result.ready).toBe(true);
  });

  it('is not ready when the slash ratio would trip the policy (demo damaged since the last reset)', async () => {
    const node = fakeAssessNode({ ...BASE, jobs: 5, slashes: 2, slashRatio: 0.4 });
    const result = await checkDemoReadiness(node, 'rugscore.assay.eth');
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.reason).toContain('reset-demo-state.ts');
      expect(result.reason).toContain('rugscore.assay.eth');
    }
  });

  it('is not ready when the bond is too thin relative to price', async () => {
    const node = fakeAssessNode({ ...BASE, bondHbar: 1, bondToPriceRatio: 0.2 });
    const result = await checkDemoReadiness(node, 'rugscore.assay.eth');
    expect(result.ready).toBe(false);
  });

  it('propagates whatever assess() throws (e.g. the name was never registered)', async () => {
    const node: Pick<AssayNode, 'assess'> = {
      assess: async () => {
        throw new Error('no assay:rep record');
      },
    };
    await expect(checkDemoReadiness(node, 'ghost.assay.eth')).rejects.toThrow('no assay:rep record');
  });
});

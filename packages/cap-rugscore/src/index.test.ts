import { describe, expect, it } from 'vitest';
import type { Capability, Claim } from '@assay/core';
import { PACKAGE_ID } from './index.js';

describe('workspace wiring', () => {
  it('resolves types across packages', () => {
    const claim: Claim = { k: 'top10Pct', v: 62, atBlock: 1 };
    expect(claim.atBlock).toBe(1);
    expect(PACKAGE_ID).toBe('@assay/cap-rugscore');
  });

  it('lets a capability be written against the core contract', async () => {
    const noop: Capability<string, { score: number }> = {
      id: 'noop',
      run: async () => ({ result: { score: 0 }, claims: [] }),
      verify: async () => ({ valid: true }),
    };
    await expect(noop.run('0x0')).resolves.toEqual({ result: { score: 0 }, claims: [] });
  });
});

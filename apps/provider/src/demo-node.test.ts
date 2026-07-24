import { describe, expect, it } from 'vitest';
import { buildDemoNode, DEMO_PROVIDER_NAME } from './demo-node.js';

describe('buildDemoNode', () => {
  it('runs the real rug-score capability end to end against named fakes, with zero network', async () => {
    const { node } = buildDemoNode();

    const discovered = await node.discover(DEMO_PROVIDER_NAME);
    expect(discovered.manifest.capabilityId).toBe('rugscore');

    const { job } = await node.payAndCall(DEMO_PROVIDER_NAME, 'rugscore', '0xTOKEN');

    expect(job.status).toBe('served');
    expect(job.result).toHaveProperty('score');
    expect(job.claims.length).toBeGreaterThan(0);
    for (const claim of job.claims) {
      expect(typeof claim.atBlock).toBe('number');
    }
  });
});

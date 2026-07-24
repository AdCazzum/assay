import { describe, expect, it } from 'vitest';
import type { Capability } from '@assay/core';
import { createRugScoreCapability, PACKAGE_ID } from './index.js';
import { FakeGraphPort } from './test-support/fake-graph-port.js';

describe('package public surface', () => {
  it('exports its package id', () => {
    expect(PACKAGE_ID).toBe('@assay/cap-rugscore');
  });

  it('createRugScoreCapability satisfies the Capability<string, {score}> contract from @assay/core', () => {
    const graph = new FakeGraphPort(1, {});
    const capability: Capability<string, { score: number }> = createRugScoreCapability({ graph });
    expect(capability.id).toBe('rugscore');
  });
});

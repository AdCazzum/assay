import { describe, expect, it } from 'vitest';
import type { Capability } from '@assay/core';
import { createLyingRugScoreProvider, createRugScoreCapability, PACKAGE_ID } from './index.js';
import { RUG_TOKEN_SIGNALS } from './fixtures.js';
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

  it('verify() re-derives and confirms an honest result through the public entry point', async () => {
    const graph = new FakeGraphPort(42, { '0xtoken': { ...RUG_TOKEN_SIGNALS, atBlock: 42 } });
    const capability = createRugScoreCapability({ graph });

    const { result, claims } = await capability.run('0xtoken');
    const verdict = await capability.verify('0xtoken', result, claims);

    expect(verdict).toEqual({ valid: true });
  });

  it('exports the declared lying-provider test harness (SPEC.md §11), importable without reaching into test-support/', async () => {
    const graph = new FakeGraphPort(42, { '0xtoken': { ...RUG_TOKEN_SIGNALS, atBlock: 42 } });
    const lying = createLyingRugScoreProvider({ graph });
    const honest = createRugScoreCapability({ graph });

    const { result, claims } = await lying.run('0xtoken');
    const verdict = await honest.verify('0xtoken', result, claims);

    expect(verdict.valid).toBe(false);
  });
});

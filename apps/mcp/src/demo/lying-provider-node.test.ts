import { afterEach, describe, expect, it } from 'vitest';
import { buildLyingProviderDemoNode, MissingConfigError } from './lying-provider-node.js';

const ENV_KEYS = ['HEDERA_OPERATOR_ID', 'HEDERA_OPERATOR_KEY', 'GRAPH_API_KEY'] as const;

describe('buildLyingProviderDemoNode', () => {
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('throws MissingConfigError naming every absent var, before constructing anything', () => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }

    let caught: unknown;
    try {
      buildLyingProviderDemoNode();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MissingConfigError);
    expect((caught as MissingConfigError).missing).toEqual([...ENV_KEYS]);
    expect((caught as Error).message).not.toMatch(/SEPOLIA|ENS_PARENT_NAME/);
  });
});

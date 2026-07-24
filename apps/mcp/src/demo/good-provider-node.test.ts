import { afterEach, describe, expect, it } from 'vitest';
import {
  buildGoodProviderDemoNode,
  FixtureGoodRegistryPort,
  GOOD_PROVIDER_NAME,
  GOOD_PROVIDER_RECORD,
  MissingConfigError,
} from './good-provider-node.js';

const ENV_KEYS = ['HEDERA_OPERATOR_ID', 'HEDERA_OPERATOR_KEY', 'GRAPH_API_KEY'] as const;

describe('FixtureGoodRegistryPort (issue #24 declared fixture)', () => {
  it('resolves the one fabricated well-collateralized record', async () => {
    const registry = new FixtureGoodRegistryPort();
    await expect(registry.resolveProvider(GOOD_PROVIDER_NAME)).resolves.toEqual(GOOD_PROVIDER_RECORD);
  });

  it('is well-collateralized on purpose: bond is a wide multiple of price with a mostly-clean record', () => {
    const { manifest, reputation } = GOOD_PROVIDER_RECORD;
    expect(reputation.bondHbar / manifest.priceHbar).toBeGreaterThanOrEqual(5);
    expect(reputation.slashes / reputation.jobs).toBeLessThan(0.15);
  });

  it('rejects any other name: this fixture only knows one fabricated provider', async () => {
    const registry = new FixtureGoodRegistryPort();
    await expect(registry.resolveProvider('something-else.assay.eth')).rejects.toThrow(
      /only resolves the fabricated/,
    );
  });

  it('publishManifest and updateReputation both refuse: not used by this demo', async () => {
    const registry = new FixtureGoodRegistryPort();
    await expect(registry.publishManifest()).rejects.toThrow();
    await expect(registry.updateReputation()).rejects.toThrow();
  });
});

describe('buildGoodProviderDemoNode', () => {
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
      buildGoodProviderDemoNode();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MissingConfigError);
    expect((caught as MissingConfigError).missing).toEqual([...ENV_KEYS]);
    // this leg's registry read is a declared fixture, not live ENS: it should
    // never demand SEPOLIA_* / ENS_PARENT_NAME the way index.ts's
    // buildLiveNodeFromEnv does.
    expect((caught as Error).message).not.toMatch(/SEPOLIA|ENS_PARENT_NAME/);
  });
});

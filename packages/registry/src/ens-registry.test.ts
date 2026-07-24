import { describe, expect, it } from 'vitest';
import type { Manifest, Reputation } from '@assay/core';
import { createEnsRegistry } from './ens-registry.js';
import { FakeEnsResolverGateway } from './ens-gateway.fake.js';
import { MANIFEST_RECORD_KEY, REPUTATION_RECORD_KEY, encodeReputation } from './manifest-codec.js';
import { MissingRecordError, NoResolverConfiguredError, UnownedNameError } from './errors.js';

const PARENT = 'assay.eth';
const NAME = 'rugscore.assay.eth';

const manifest: Manifest = {
  capabilityId: 'rugscore',
  description: 'rug-pull risk score for an ERC-20 token',
  priceHbar: 5,
  endpoint: 'https://provider.example/rugscore',
  bondRef: 'bond-0x123',
  verifierHash: '0xabc',
};

const reputation: Reputation = { score: 87, jobs: 12, slashes: 0, bondHbar: 50 };

function registryWith(gateway: FakeEnsResolverGateway) {
  return createEnsRegistry({
    rpcUrl: 'unused-in-tests',
    privateKey: 'unused-in-tests',
    parentName: PARENT,
    gateway,
  });
}

describe('createEnsRegistry: publishManifest', () => {
  it('writes the manifest to the assay:manifest text record', async () => {
    const gateway = new FakeEnsResolverGateway();
    const registry = registryWith(gateway);

    const { txHash } = await registry.publishManifest(NAME, manifest);

    expect(txHash).toMatch(/^0xfake/);
    await expect(gateway.getText(NAME, MANIFEST_RECORD_KEY)).resolves.toBe(JSON.stringify(manifest));
  });

  it('refuses to publish under a name outside the configured parent', async () => {
    const gateway = new FakeEnsResolverGateway();
    const registry = registryWith(gateway);

    await expect(registry.publishManifest('rugscore.someoneelse.eth', manifest)).rejects.toThrow(
      UnownedNameError,
    );
  });

  it('surfaces a clear error when the subname has no resolver configured', async () => {
    const gateway = new FakeEnsResolverGateway().withNoResolver(NAME);
    const registry = registryWith(gateway);

    await expect(registry.publishManifest(NAME, manifest)).rejects.toThrow(NoResolverConfiguredError);
  });
});

describe('createEnsRegistry: resolveProvider', () => {
  it('round-trips manifest + reputation back into a ProviderRecord', async () => {
    const gateway = new FakeEnsResolverGateway()
      .seedText(NAME, MANIFEST_RECORD_KEY, JSON.stringify(manifest))
      .seedText(NAME, REPUTATION_RECORD_KEY, encodeReputation(reputation));
    const registry = registryWith(gateway);

    const record = await registry.resolveProvider(NAME);

    expect(record).toEqual({ name: NAME, manifest, reputation });
  });

  it('throws a typed error when the manifest record is missing', async () => {
    const gateway = new FakeEnsResolverGateway().seedText(
      NAME,
      REPUTATION_RECORD_KEY,
      encodeReputation(reputation),
    );
    const registry = registryWith(gateway);

    await expect(registry.resolveProvider(NAME)).rejects.toThrow(MissingRecordError);
  });

  it('throws a typed error when the reputation record is missing', async () => {
    const gateway = new FakeEnsResolverGateway().seedText(
      NAME,
      MANIFEST_RECORD_KEY,
      JSON.stringify(manifest),
    );
    const registry = registryWith(gateway);

    await expect(registry.resolveProvider(NAME)).rejects.toThrow(MissingRecordError);
  });

  it('throws a typed error when the manifest record is malformed JSON', async () => {
    const gateway = new FakeEnsResolverGateway()
      .seedText(NAME, MANIFEST_RECORD_KEY, '{not json')
      .seedText(NAME, REPUTATION_RECORD_KEY, encodeReputation(reputation));
    const registry = registryWith(gateway);

    await expect(registry.resolveProvider(NAME)).rejects.toThrow(/malformed/);
  });

  it('throws a typed error when the manifest JSON is well-formed but the wrong shape', async () => {
    const gateway = new FakeEnsResolverGateway()
      .seedText(NAME, MANIFEST_RECORD_KEY, JSON.stringify({ oops: true }))
      .seedText(NAME, REPUTATION_RECORD_KEY, encodeReputation(reputation));
    const registry = registryWith(gateway);

    await expect(registry.resolveProvider(NAME)).rejects.toThrow(/capabilityId/);
  });

  it('surfaces a clear error when the name has no resolver configured', async () => {
    const gateway = new FakeEnsResolverGateway().withNoResolver(NAME);
    const registry = registryWith(gateway);

    await expect(registry.resolveProvider(NAME)).rejects.toThrow(NoResolverConfiguredError);
  });

  it('refuses to resolve a name outside the configured parent', async () => {
    const gateway = new FakeEnsResolverGateway();
    const registry = registryWith(gateway);

    await expect(registry.resolveProvider('rugscore.someoneelse.eth')).rejects.toThrow(UnownedNameError);
  });
});

describe('createEnsRegistry: updateReputation', () => {
  it('is out of scope for this issue and says so', async () => {
    const registry = registryWith(new FakeEnsResolverGateway());

    await expect(registry.updateReputation(NAME, { score: 1 })).rejects.toThrow(/#16/);
  });
});

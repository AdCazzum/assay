import { describe, expect, it, vi } from 'vitest';
import type { Manifest, Reputation } from '@assay/core';
import { createEnsRegistry, type ReputationWriteProgress } from './ens-registry.js';
import { FakeEnsResolverGateway } from './ens-gateway.fake.js';
import { MANIFEST_RECORD_KEY, REPUTATION_RECORD_KEY, encodeReputation } from './manifest-codec.js';
import {
  InvalidReputationError,
  MissingRecordError,
  NoResolverConfiguredError,
  UnownedNameError,
} from './errors.js';

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

function registryWith(
  gateway: FakeEnsResolverGateway,
  onReputationWriteAttempt?: (info: ReputationWriteProgress) => void,
) {
  return createEnsRegistry({
    rpcUrl: 'unused-in-tests',
    privateKey: 'unused-in-tests',
    parentName: PARENT,
    gateway,
    onReputationWriteAttempt,
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

  // Regression: found by running the live smoke against Sepolia. ethers reports
  // an unset text record as an empty string, not null, so a freshly registered
  // provider (manifest written, reputation not yet initialised) reached the JSON
  // decoder and was reported as having a *corrupt* record. Opposite diagnosis to
  // the truth, on the exact path a requester hits first.
  it('reports an empty reputation record as missing rather than malformed', async () => {
    const gateway = new FakeEnsResolverGateway()
      .seedText(NAME, MANIFEST_RECORD_KEY, JSON.stringify(manifest))
      .seedText(NAME, REPUTATION_RECORD_KEY, '');
    const registry = registryWith(gateway);

    await expect(registry.resolveProvider(NAME)).rejects.toThrow(MissingRecordError);
    await expect(registry.resolveProvider(NAME)).rejects.not.toThrow(/malformed/);
  });

  it('reports a whitespace-only manifest record as missing rather than malformed', async () => {
    const gateway = new FakeEnsResolverGateway()
      .seedText(NAME, MANIFEST_RECORD_KEY, '   ')
      .seedText(NAME, REPUTATION_RECORD_KEY, encodeReputation(reputation));
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
  it('initializes from an unset assay:rep record rather than failing', async () => {
    const gateway = new FakeEnsResolverGateway();
    const registry = registryWith(gateway);

    const { txHash, reputation } = await registry.updateReputation(NAME, { score: 80, bondHbar: 50 });

    // Fields not in the delta start from the zero base, not undefined/NaN.
    expect(reputation).toEqual({ score: 80, jobs: 0, slashes: 0, bondHbar: 50 });
    expect(txHash).toMatch(/^0xfake/);
    await expect(gateway.getText(NAME, REPUTATION_RECORD_KEY)).resolves.toBe(JSON.stringify(reputation));
  });

  it('treats a whitespace-only assay:rep record the same as unset (isUnset)', async () => {
    const gateway = new FakeEnsResolverGateway().seedText(NAME, REPUTATION_RECORD_KEY, '   ');
    const registry = registryWith(gateway);

    const { reputation } = await registry.updateReputation(NAME, { jobs: 1 });

    expect(reputation).toEqual({ score: 0, jobs: 1, slashes: 0, bondHbar: 0 });
  });

  it('reads the current record, merges delta as an absolute patch (not an increment), and writes the result', async () => {
    const existing: Reputation = { score: 87, jobs: 12, slashes: 0, bondHbar: 50 };
    const gateway = new FakeEnsResolverGateway().seedText(NAME, REPUTATION_RECORD_KEY, encodeReputation(existing));
    const registry = registryWith(gateway);

    // A caller meaning "one more slash, score down to 36" reads the current
    // value and passes the new absolute value, matching the semantics this
    // repo's other RegistryPort fakes already commit to (see the doc
    // comment on `updateReputation`).
    const { reputation } = await registry.updateReputation(NAME, { slashes: 1, score: 36 });

    // jobs/bondHbar were not in the delta, so they carry over untouched.
    expect(reputation).toEqual({ score: 36, jobs: 12, slashes: 1, bondHbar: 50 });
    await expect(gateway.getText(NAME, REPUTATION_RECORD_KEY)).resolves.toBe(JSON.stringify(reputation));
  });

  it('an empty delta is a no-op merge that still re-publishes the unchanged record', async () => {
    const existing: Reputation = { score: 87, jobs: 12, slashes: 0, bondHbar: 50 };
    const gateway = new FakeEnsResolverGateway().seedText(NAME, REPUTATION_RECORD_KEY, encodeReputation(existing));
    const registry = registryWith(gateway);

    const { reputation } = await registry.updateReputation(NAME, {});

    expect(reputation).toEqual(existing);
  });

  it('refuses to publish a score above 100', async () => {
    const gateway = new FakeEnsResolverGateway().seedText(
      NAME,
      REPUTATION_RECORD_KEY,
      encodeReputation({ score: 95, jobs: 0, slashes: 0, bondHbar: 0 }),
    );
    const registry = registryWith(gateway);

    await expect(registry.updateReputation(NAME, { score: 120 })).rejects.toThrow(InvalidReputationError);
    // Nothing was written: the pre-existing record is untouched.
    await expect(gateway.getText(NAME, REPUTATION_RECORD_KEY)).resolves.toBe(
      encodeReputation({ score: 95, jobs: 0, slashes: 0, bondHbar: 0 }),
    );
  });

  it('refuses to publish a negative score', async () => {
    const registry = registryWith(new FakeEnsResolverGateway());

    await expect(registry.updateReputation(NAME, { score: -1 })).rejects.toThrow(InvalidReputationError);
  });

  it('refuses to publish negative jobs', async () => {
    const registry = registryWith(new FakeEnsResolverGateway());

    await expect(registry.updateReputation(NAME, { jobs: -1 })).rejects.toThrow(InvalidReputationError);
  });

  it('refuses to publish negative slashes', async () => {
    const registry = registryWith(new FakeEnsResolverGateway());

    await expect(registry.updateReputation(NAME, { slashes: -1 })).rejects.toThrow(InvalidReputationError);
  });

  it('refuses to publish a negative bond', async () => {
    const registry = registryWith(new FakeEnsResolverGateway());

    await expect(registry.updateReputation(NAME, { bondHbar: -1 })).rejects.toThrow(InvalidReputationError);
  });

  it('refuses to update a name outside the configured parent', async () => {
    const registry = registryWith(new FakeEnsResolverGateway());

    await expect(registry.updateReputation('rugscore.someoneelse.eth', { score: 1 })).rejects.toThrow(
      UnownedNameError,
    );
  });

  it('surfaces a clear error when the name has no resolver configured', async () => {
    const gateway = new FakeEnsResolverGateway().withNoResolver(NAME);
    const registry = registryWith(gateway);

    await expect(registry.updateReputation(NAME, { score: 1 })).rejects.toThrow(NoResolverConfiguredError);
  });

  it('reports write progress through onReputationWriteAttempt: reading, writing, done', async () => {
    const gateway = new FakeEnsResolverGateway();
    const onReputationWriteAttempt = vi.fn<(info: ReputationWriteProgress) => void>();
    const registry = registryWith(gateway, onReputationWriteAttempt);

    const { txHash } = await registry.updateReputation(NAME, { score: 42 });

    const phases = onReputationWriteAttempt.mock.calls.map(([info]) => info.phase);
    // reading, then at least one writing tick (submitted + confirmed from
    // the fake gateway), then a final done — never frozen silence.
    expect(phases[0]).toBe('reading');
    expect(phases).toContain('writing');
    expect(phases.at(-1)).toBe('done');

    const done = onReputationWriteAttempt.mock.calls.map(([info]) => info).find((info) => info.phase === 'done');
    expect(done).toMatchObject({ phase: 'done', txHash });
    expect(done && 'elapsedMs' in done && typeof done.elapsedMs).toBe('number');
  });

  it('does not call onReputationWriteAttempt when the caller did not ask for it', async () => {
    // No callback wired up at all: updateReputation must not assume one exists.
    const registry = registryWith(new FakeEnsResolverGateway());

    await expect(registry.updateReputation(NAME, { score: 1 })).resolves.toBeDefined();
  });
});

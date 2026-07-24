import { describe, expect, it } from 'vitest';
import type { Manifest, Reputation } from '@assay/core';
import {
  decodeManifest,
  decodeReputation,
  encodeManifest,
  encodeReputation,
} from './manifest-codec.js';
import { MalformedRecordError } from './errors.js';

const manifest: Manifest = {
  capabilityId: 'rugscore',
  description: 'rug-pull risk score for an ERC-20 token',
  priceHbar: 5,
  endpoint: 'https://provider.example/rugscore',
  bondRef: 'bond-0x123',
  verifierHash: '0xabc',
};

const reputation: Reputation = { score: 87, jobs: 12, slashes: 0, bondHbar: 50 };

describe('manifest codec', () => {
  it('round-trips a manifest through JSON encode/decode', () => {
    const decoded = decodeManifest(encodeManifest(manifest), 'rugscore.assay.eth');
    expect(decoded).toEqual(manifest);
  });

  it('round-trips a reputation through JSON encode/decode', () => {
    const decoded = decodeReputation(encodeReputation(reputation), 'rugscore.assay.eth');
    expect(decoded).toEqual(reputation);
  });

  it('rejects a manifest record that is not valid JSON', () => {
    expect(() => decodeManifest('{not json', 'rugscore.assay.eth')).toThrow(MalformedRecordError);
  });

  it('rejects a manifest record missing a required field', () => {
    const raw = JSON.stringify({ ...manifest, endpoint: undefined });
    expect(() => decodeManifest(raw, 'rugscore.assay.eth')).toThrow(MalformedRecordError);
  });

  it('rejects a manifest record with the wrong type for priceHbar', () => {
    const raw = JSON.stringify({ ...manifest, priceHbar: '5' });
    expect(() => decodeManifest(raw, 'rugscore.assay.eth')).toThrow(/priceHbar/);
  });

  it('rejects a reputation record that is a JSON array, not an object', () => {
    expect(() => decodeReputation('[1,2,3]', 'rugscore.assay.eth')).toThrow(MalformedRecordError);
  });
});

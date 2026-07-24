/**
 * `RegistryPort` over ENS on Sepolia. See SPEC.md §4, §5, §12.
 *
 * `publishManifest` / `resolveProvider` (issue #15) are implemented here.
 * `updateReputation` is issue #16 and is out of scope: it throws explicitly
 * rather than silently doing nothing, so nobody mistakes the stub for a
 * working implementation.
 */

import type { Manifest, ProviderRecord, RegistryPort, Reputation } from '@assay/core';
import { createEthersEnsGateway, type EnsResolverGateway } from './ens-gateway.js';
import { UnownedNameError } from './errors.js';
import {
  MANIFEST_RECORD_KEY,
  REPUTATION_RECORD_KEY,
  decodeManifest,
  decodeReputation,
  encodeManifest,
} from './manifest-codec.js';
import { MissingRecordError } from './errors.js';

export interface CreateEnsRegistryOptions {
  /** Sepolia JSON-RPC endpoint. Ignored if `gateway` is supplied. */
  rpcUrl: string;
  /** Private key of the wallet that owns `parentName` (and its subnames). Ignored if `gateway` is supplied. */
  privateKey: string;
  /** e.g. `assay.eth`. Every `name` passed in must equal this or be a subname under it. */
  parentName: string;
  /**
   * Overrides the resolver gateway. This is the seam unit tests use to drive
   * a `FakeEnsResolverGateway` in place of real Sepolia RPC calls; production
   * callers should never set it (the real `createEthersEnsGateway` is built
   * from `rpcUrl`/`privateKey` when omitted).
   */
  gateway?: EnsResolverGateway;
}

/**
 * A text record that was never written is not a broken one.
 *
 * ethers reports an unset record as an empty string, and only returns null
 * when the resolver cannot answer at all. Both mean "nothing here", and both
 * have to be caught before the JSON decoder sees them, or an uninitialised
 * provider is reported as having a corrupt record. That distinction matters
 * to whoever reads the error: "not set yet" is the normal state of a name
 * that was just registered, "malformed" says someone wrote garbage into it.
 */
function isUnset(raw: string | null): raw is null {
  return raw === null || raw.trim() === '';
}

export function createEnsRegistry(opts: CreateEnsRegistryOptions): RegistryPort {
  const gateway = opts.gateway ?? createEthersEnsGateway({ rpcUrl: opts.rpcUrl, privateKey: opts.privateKey });
  const parentName = opts.parentName;

  function assertOwnedName(name: string): void {
    if (name !== parentName && !name.endsWith(`.${parentName}`)) {
      throw new UnownedNameError(name, parentName);
    }
  }

  return {
    async publishManifest(name, manifest: Manifest) {
      assertOwnedName(name);
      const { txHash } = await gateway.setText(name, MANIFEST_RECORD_KEY, encodeManifest(manifest));
      return { txHash };
    },

    async resolveProvider(name): Promise<ProviderRecord> {
      assertOwnedName(name);

      const manifestRaw = await gateway.getText(name, MANIFEST_RECORD_KEY);
      if (isUnset(manifestRaw)) {
        throw new MissingRecordError(MANIFEST_RECORD_KEY, name);
      }
      const manifest = decodeManifest(manifestRaw, name);

      const reputationRaw = await gateway.getText(name, REPUTATION_RECORD_KEY);
      if (isUnset(reputationRaw)) {
        throw new MissingRecordError(REPUTATION_RECORD_KEY, name);
      }
      const reputation = decodeReputation(reputationRaw, name);

      return { name, manifest, reputation };
    },

    async updateReputation(_name: string, _delta: Partial<Reputation>) {
      throw new Error('updateReputation is tracked in #16');
    },
  };
}

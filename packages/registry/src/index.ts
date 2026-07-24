/**
 * @assay/registry — ENS registry adapter (Sepolia). See SPEC.md §4.
 *
 * `createEnsRegistry` implements the full `RegistryPort`: `publishManifest` /
 * `resolveProvider` (issue #15) and `updateReputation` (issue #16), all
 * against Sepolia.
 */

export {
  createEnsRegistry,
  type CreateEnsRegistryOptions,
  type ReputationWriteProgress,
} from './ens-registry.js';
export {
  createEthersEnsGateway,
  type EnsResolverGateway,
  type CreateEthersEnsGatewayOptions,
  type EnsWriteAttempt,
  type EnsWriteAttemptState,
} from './ens-gateway.js';
export {
  MANIFEST_RECORD_KEY,
  REPUTATION_RECORD_KEY,
  encodeManifest,
  encodeReputation,
  decodeManifest,
  decodeReputation,
} from './manifest-codec.js';
export {
  EnsRegistryError,
  NoResolverConfiguredError,
  MissingRecordError,
  MalformedRecordError,
  UnownedNameError,
  InvalidReputationError,
} from './errors.js';

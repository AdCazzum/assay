/**
 * @assay/registry — ENS registry adapter (Sepolia). See SPEC.md §4.
 *
 * `createEnsRegistry` implements `RegistryPort`'s manifest half
 * (`publishManifest` / `resolveProvider`, issue #15) for real, against
 * Sepolia. `updateReputation` is issue #16 and throws explicitly until then.
 */

export { createEnsRegistry, type CreateEnsRegistryOptions } from './ens-registry.js';
export { createEthersEnsGateway, type EnsResolverGateway, type CreateEthersEnsGatewayOptions } from './ens-gateway.js';
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
} from './errors.js';

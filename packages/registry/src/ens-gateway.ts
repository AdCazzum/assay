/**
 * The injectable seam between `createEnsRegistry` and the chain. See SPEC.md
 * §4 and §12.
 *
 * `EnsResolverGateway` is deliberately narrower than "an ethers Provider and
 * Signer": it exposes only the three ENS text-record operations this package
 * needs. A test double only has to implement three async methods over a
 * `Map`, instead of the whole JSON-RPC surface ethers' `Provider`/`Contract`
 * machinery would otherwise require (fee data, gas estimation, nonce
 * tracking, tx broadcast, receipts, ...). The real implementation below
 * (`createEthersEnsGateway`) is the one and only place that talks to actual
 * Sepolia RPC; everything above it in `ens-registry.ts` is chain-agnostic and
 * is what unit tests exercise via `FakeEnsResolverGateway`.
 */

import { AbstractProvider, Contract, JsonRpcProvider, Wallet, namehash } from 'ethers';
import { NoResolverConfiguredError } from './errors.js';

export interface EnsResolverGateway {
  /**
   * Reads text record `key` for `name`. Returns `null` if the resolver has
   * no value set for that key. Throws `NoResolverConfiguredError` if `name`
   * has no resolver at all.
   */
  getText(name: string, key: string): Promise<string | null>;
  /**
   * Writes text record `key` for `name` and waits for the transaction to be
   * mined. Throws `NoResolverConfiguredError` if `name` has no resolver.
   */
  setText(name: string, key: string, value: string): Promise<{ txHash: string }>;
}

/**
 * Chain target: **Sepolia** (chainId 11155111). ethers v6 ships Sepolia as a
 * built-in named network with its ENS plugin already wired to the standard
 * ENS Registry address (`0x00000000000C2E074eC69A0dFb2997BA6C7d2e1`, the same
 * address ENS is deployed at on every network it supports) — see
 * `ethers`' `injectCommonNetworks` in `providers/network.js`. So
 * `provider.getResolver(name)` on a Sepolia `JsonRpcProvider` resolves
 * through the real Sepolia ENS Registry with no hardcoding on our side.
 *
 * The **resolver address itself is intentionally not hardcoded either**: it
 * is whatever `assay.eth` (or the subname)'s owner currently has set as its
 * resolver (in practice ENS's `PublicResolver`), discovered per-name via
 * `getResolver`. Hardcoding a resolver address here would be exactly the
 * "canned fallback" SPEC.md §12 rules out.
 */
const SEPOLIA_CHAIN_ID = 11155111;

/** The subset of PublicResolver's ABI (EIP-634 text records) we call. */
const TEXT_RESOLVER_ABI = [
  'function setText(bytes32 node, string calldata key, string calldata value) external',
] as const;

export interface CreateEthersEnsGatewayOptions {
  rpcUrl: string;
  privateKey: string;
  /** Overrides the ethers provider (e.g. a already-connected one). Rarely needed. */
  provider?: AbstractProvider;
}

export function createEthersEnsGateway(opts: CreateEthersEnsGatewayOptions): EnsResolverGateway {
  const provider = opts.provider ?? new JsonRpcProvider(opts.rpcUrl, SEPOLIA_CHAIN_ID);
  const signer = new Wallet(opts.privateKey, provider);

  return {
    async getText(name, key) {
      const resolver = await provider.getResolver(name);
      if (!resolver) {
        throw new NoResolverConfiguredError(name);
      }
      return resolver.getText(key);
    },

    async setText(name, key, value) {
      const resolver = await provider.getResolver(name);
      if (!resolver) {
        throw new NoResolverConfiguredError(name);
      }
      const writable = new Contract(resolver.address, TEXT_RESOLVER_ABI, signer);
      const tx = await writable.setText(namehash(name), key, value);
      const receipt = await tx.wait();
      return { txHash: receipt?.hash ?? tx.hash };
    },
  };
}

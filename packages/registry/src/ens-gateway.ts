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

/**
 * Progress ticks for a `setText` write. Mirrors `@assay/payments`'
 * `onConfirmAttempt`/`MirrorNodePollAttempt` shape on purpose (see
 * `mirror-node.ts`): same idea — a slow on-chain confirmation is observable
 * instead of a single black-box `await`, so a caller (the dashboard) can show
 * "in flight" rather than freezing for the ~24s an ENS write takes (#53).
 *
 * `'submitted'` fires once, right after the transaction is broadcast (the
 * tx hash is already known). `'pending'` fires on a heartbeat while waiting
 * for it to be mined. `'confirmed'` fires once, after the receipt lands.
 */
export type EnsWriteAttemptState = 'submitted' | 'pending' | 'confirmed';

export type EnsWriteAttempt = {
  state: EnsWriteAttemptState;
  elapsedMs: number;
};

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
   *
   * `onAttempt`, when given, is called as the write progresses (see
   * `EnsWriteAttempt`) so a slow confirmation is observable rather than a
   * single opaque `await`.
   */
  setText(
    name: string,
    key: string,
    value: string,
    onAttempt?: (info: EnsWriteAttempt) => void,
  ): Promise<{ txHash: string }>;
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
  /** Heartbeat interval for `onAttempt`'s `'pending'` ticks while a write is mining. Default 3s. */
  writeHeartbeatMs?: number;
}

const DEFAULT_WRITE_HEARTBEAT_MS = 3_000;

export function createEthersEnsGateway(opts: CreateEthersEnsGatewayOptions): EnsResolverGateway {
  const provider = opts.provider ?? new JsonRpcProvider(opts.rpcUrl, SEPOLIA_CHAIN_ID);
  const signer = new Wallet(opts.privateKey, provider);
  const heartbeatMs = opts.writeHeartbeatMs ?? DEFAULT_WRITE_HEARTBEAT_MS;

  return {
    async getText(name, key) {
      const resolver = await provider.getResolver(name);
      if (!resolver) {
        throw new NoResolverConfiguredError(name);
      }
      return resolver.getText(key);
    },

    async setText(name, key, value, onAttempt) {
      const resolver = await provider.getResolver(name);
      if (!resolver) {
        throw new NoResolverConfiguredError(name);
      }
      const writable = new Contract(resolver.address, TEXT_RESOLVER_ABI, signer);
      const start = Date.now();

      const tx = await writable.setText(namehash(name), key, value);
      onAttempt?.({ state: 'submitted', elapsedMs: Date.now() - start });

      // ethers' own `tx.wait()` already handles the actual poll-for-receipt
      // logic (reorg-safe, robust); this heartbeat just runs alongside it so
      // `onAttempt` fires periodically during the wait instead of only
      // before and after it, matching `pollMirrorNode`'s per-attempt ticks.
      const heartbeat = onAttempt
        ? setInterval(() => onAttempt({ state: 'pending', elapsedMs: Date.now() - start }), heartbeatMs)
        : undefined;

      try {
        const receipt = await tx.wait();
        onAttempt?.({ state: 'confirmed', elapsedMs: Date.now() - start });
        return { txHash: receipt?.hash ?? tx.hash };
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
    },
  };
}

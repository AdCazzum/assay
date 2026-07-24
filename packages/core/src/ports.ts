/**
 * The seams between the core and the three networks. See SPEC.md §4.
 *
 * The core depends only on these interfaces, never on ethers / the Hedera SDK /
 * the Token API directly. That is what lets the payment rail be swapped
 * (x402 <-> raw HBAR transfer) without the core noticing, and what lets each
 * adapter be built and tested on its own.
 */

import type { Manifest, ProviderRecord, Reputation } from './types.js';

/** ENS on Sepolia: identity (manifest) and portable reputation. */
export interface RegistryPort {
  resolveProvider(name: string): Promise<ProviderRecord>;
  publishManifest(name: string, manifest: Manifest): Promise<{ txHash: string }>;
  updateReputation(
    name: string,
    delta: Partial<Reputation>,
  ): Promise<{ txHash: string; reputation: Reputation }>;
}

/** Hedera testnet: pay per call, provider bond, slash. */
export interface PaymentsPort {
  /** Pays `amountHbar`, binding `requestHash` to the transaction. */
  pay(amountHbar: number, requestHash: string): Promise<{ txId: string }>;
  /** Polls the mirror node until the transaction is final. */
  confirm(txId: string): Promise<boolean>;
  postBond(amountHbar: number): Promise<{ bondRef: string; txId: string }>;
  slash(bondRef: string, toChallenger: string): Promise<{ txId: string }>;
}

/**
 * Signals for a token at a given block. The shape is deliberately open: the
 * rug-score capability picks the fields it cares about, and the verifier
 * re-derives exactly the same fields at exactly the same block.
 */
export type TokenSignals = {
  atBlock: number;
  holders: number;
  top10Pct: number;
  liquidityUsd: number;
  ageBlocks: number;
  transfers: number;
  hasActiveMintRole: boolean;
};

/** The Graph Token API (mainnet, read-only): the source of truth. */
export interface GraphPort {
  getTokenSignals(token: string, atBlock?: number): Promise<TokenSignals>;
  /** The chain head, used to stamp claims at serve time. */
  getLatestBlock(): Promise<number>;
}

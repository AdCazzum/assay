/**
 * `PaymentsPort` (see @assay/core ports.ts) backed by the raw-HBAR-transfer
 * rail. See ../README.md for why: no sponsor rail (x402 facilitator, Hedera
 * Agent Kit) was picked for this build.
 *
 * Design note on the two params `PaymentsPort` doesn't carry: `pay` takes no
 * recipient and `postBond`/`slash` take no bond amount, because the frozen
 * interface doesn't have room for them. This factory resolves that by binding
 * the counterparty accounts at construction time (one `PaymentsPort` instance
 * per relationship: a requester's instance knows which provider it pays, a
 * provider's instance knows its own bond-escrow account) and by keeping bond
 * amounts in a small in-memory ledger keyed by `bondRef`, looked up again on
 * `slash`. SPEC.md §17 rules out a real staking protocol, so this ledger is
 * intentionally just enough bookkeeping for "deposit, then transfer" — it is
 * not durable and does not survive a process restart, matching the "no
 * persistence beyond the in-memory job store" scope cut.
 */

import type { PaymentsPort } from '@assay/core';
import type { HederaTransferClient } from './hedera-client.js';
import type { FetchLike, MirrorNodePollAttempt } from './mirror-node.js';
import { pollMirrorNode } from './mirror-node.js';

export type HederaPaymentsPortConfig = {
  /** Injected so tests can drive a `FakeHederaTransferClient` (see hedera-client tests). */
  client: HederaTransferClient;
  /** Account `pay()` sends to (e.g. the provider being called). */
  payToAccountId: string;
  /** Account `postBond()` sends to (e.g. the protocol's bond-escrow account). */
  bondAccountId: string;
  /** e.g. "https://testnet.mirrornode.hedera.com". */
  mirrorNodeBaseUrl: string;
  /** Injected so tests can drive a fake mirror node instead of a live one. */
  fetchImpl: FetchLike;
  confirmTimeoutMs?: number;
  confirmIntervalMs?: number;
  onConfirmAttempt?: (info: MirrorNodePollAttempt) => void;
};

type BondEntry = {
  amountHbar: number;
  slashed: boolean;
};

export function createHederaPaymentsPort(config: HederaPaymentsPortConfig): PaymentsPort {
  const bonds = new Map<string, BondEntry>();
  let bondSeq = 0;

  return {
    async pay(amountHbar, requestHash) {
      return config.client.transferHbar({
        toAccountId: config.payToAccountId,
        amountHbar,
        memo: requestHash,
      });
    },

    async confirm(txId) {
      return pollMirrorNode(txId, {
        baseUrl: config.mirrorNodeBaseUrl,
        fetchImpl: config.fetchImpl,
        timeoutMs: config.confirmTimeoutMs,
        intervalMs: config.confirmIntervalMs,
        onAttempt: config.onConfirmAttempt,
      });
    },

    async postBond(amountHbar) {
      const { txId } = await config.client.transferHbar({
        toAccountId: config.bondAccountId,
        amountHbar,
      });
      bondSeq += 1;
      const bondRef = `bond-${bondSeq}-${txId}`;
      bonds.set(bondRef, { amountHbar, slashed: false });
      return { bondRef, txId };
    },

    async slash(bondRef, toChallenger) {
      const bond = bonds.get(bondRef);
      if (!bond) {
        throw new Error(`slash: unknown bondRef "${bondRef}"`);
      }
      if (bond.slashed) {
        throw new Error(`slash: bondRef "${bondRef}" was already slashed`);
      }
      const { txId } = await config.client.transferHbar({
        toAccountId: toChallenger,
        amountHbar: bond.amountHbar,
      });
      bond.slashed = true;
      return { txId };
    },
  };
}

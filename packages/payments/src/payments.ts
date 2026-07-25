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
 *
 * `confirm(txId)` only ever checked the mirror node's `result` field (SUCCESS
 * or not) — nothing about who was paid, how much, or the memo. That was the
 * whole payment gate `@assay/core`'s `serve()` relied on, so any confirmed
 * txId, including an already-spent one, unlocked any capability run
 * regardless of price (hedera-F1). `confirmPayment` closes that: it re-reads
 * the same mirror node transaction and additionally checks that
 * `payToAccountId` (this instance's own configured recipient) actually
 * received at least the expected amount, and that the memo matches the
 * request it is supposed to be bound to.
 */

import type { PaymentConfirmation, PaymentsPort } from '@assay/core';
import type { HederaTransferClient } from './hedera-client.js';
import type { FetchLike, MirrorNodePollAttempt } from './mirror-node.js';
import { pollMirrorNode, pollMirrorNodeTransaction, TINYBARS_PER_HBAR } from './mirror-node.js';

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

  /**
   * Recovers a bond's amount from the transaction its `bondRef` names.
   *
   * `bondRef` is `bond-<seq>-<txId>`, so the transaction id is everything
   * after the second dash. The amount is what actually arrived at the bond
   * account in that transaction, read off the mirror node.
   */
  async function resolveBondAmountFromChain(bondRef: string): Promise<number> {
    const txId = bondRef.replace(/^bond-\d+-/, '');
    if (txId === bondRef) {
      throw new Error(
        `slash: unknown bondRef "${bondRef}", and it does not carry a transaction id to recover the amount from.`,
      );
    }

    let detail;
    try {
      detail = await pollMirrorNodeTransaction(txId, {
        baseUrl: config.mirrorNodeBaseUrl,
        fetchImpl: config.fetchImpl,
        timeoutMs: config.confirmTimeoutMs,
        intervalMs: config.confirmIntervalMs,
      });
    } catch (err) {
      throw new Error(
        `slash: bondRef "${bondRef}" is not in this process's ledger and its transaction could not be read ` +
          `from the mirror node (${err instanceof Error ? err.message : String(err)}). Refusing to slash an amount it cannot verify.`,
      );
    }

    if (detail.state !== 'success') {
      throw new Error(`slash: the transaction behind bondRef "${bondRef}" is ${detail.state}, not a settled bond.`);
    }

    const receivedTinybars = detail.transfers
      .filter((t) => t.accountId === config.bondAccountId)
      .reduce((sum, t) => sum + t.amountTinybars, 0);

    if (receivedTinybars <= 0) {
      throw new Error(
        `slash: the transaction behind bondRef "${bondRef}" moved nothing to the bond account ${config.bondAccountId}, ` +
          'so there is no bond to slash. A self-transfer nets to zero here and cannot back a bond.',
      );
    }

    return receivedTinybars / TINYBARS_PER_HBAR;
  }

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

    async confirmPayment({ txId, expectedAmountHbar, expectedMemo }): Promise<PaymentConfirmation> {
      const detail = await pollMirrorNodeTransaction(txId, {
        baseUrl: config.mirrorNodeBaseUrl,
        fetchImpl: config.fetchImpl,
        timeoutMs: config.confirmTimeoutMs,
        intervalMs: config.confirmIntervalMs,
        onAttempt: config.onConfirmAttempt,
      });

      if (detail.state !== 'success') {
        return { confirmed: false, reason: 'unsuccessful' };
      }

      // The recipient this instance itself pays (config.payToAccountId,
      // bound at construction, see the module doc comment on why `pay()`
      // has no recipient parameter) must actually be credited at least the
      // expected amount. Rounding to the nearest tinybar avoids float noise
      // from `amountHbar` values like 0.01 or 5.
      const expectedTinybars = Math.round(expectedAmountHbar * TINYBARS_PER_HBAR);
      const receivedTinybars = detail.transfers
        .filter((t) => t.accountId === config.payToAccountId)
        .reduce((sum, t) => sum + t.amountTinybars, 0);
      if (receivedTinybars < expectedTinybars) {
        return { confirmed: false, reason: 'amount-too-low' };
      }

      if (detail.memo !== expectedMemo) {
        return { confirmed: false, reason: 'memo-mismatch' };
      }

      return { confirmed: true };
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
      let bond = bonds.get(bondRef);
      if (!bond) {
        // The ledger is per-process, and a bond is routinely posted by one
        // process and slashed by another: the reset script posts it, the MCP
        // server slashes it when an agent challenges. That is not an edge
        // case, it is the demo's own shape, and it used to fail here with
        // "unknown bondRef" at the exact moment the climax lands.
        //
        // The bondRef carries the transaction that funded it, so the amount is
        // recoverable from the chain. Reading it back is also strictly better
        // than trusting the local number was: it verifies what was actually
        // bonded rather than what this process believes it bonded.
        const amountHbar = await resolveBondAmountFromChain(bondRef);
        bond = { amountHbar, slashed: false };
        bonds.set(bondRef, bond);
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

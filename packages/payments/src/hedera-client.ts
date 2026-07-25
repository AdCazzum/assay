/**
 * The transfer client seam. `createHederaPaymentsPort` (payments.ts) depends
 * only on this interface, never on `@hashgraph/sdk` directly, so unit tests
 * can drive an obviously-named fake instead of a live testnet account.
 */

import { AccountId, Client, Hbar, TransferTransaction } from '@hashgraph/sdk';

import { parseOperatorKey, type HederaKeyType } from './operator-key.js';

export type HederaNetwork = 'testnet' | 'mainnet' | 'previewnet';

export type TransferHbarParams = {
  toAccountId: string;
  amountHbar: number;
  /** Written to the transaction memo. Hedera memos are capped at 100 bytes. */
  memo?: string;
};

export interface HederaTransferClient {
  /** Transfers `amountHbar` from the configured operator to `toAccountId`. */
  transferHbar(params: TransferHbarParams): Promise<{ txId: string }>;
  /** Releases the underlying SDK client's network connections. */
  close(): void;
}

export type HederaSdkClientConfig = {
  operatorId: string;
  operatorKey: string;
  network?: HederaNetwork;
  /**
   * The curve of `operatorKey`. Omit for a DER-encoded key (which names its
   * own curve) or to take the ECDSA default for bare hex. See operator-key.ts
   * for why this is never guessed silently.
   */
  keyType?: HederaKeyType;
};

function forNetwork(network: HederaNetwork): Client {
  switch (network) {
    case 'testnet':
      return Client.forTestnet();
    case 'mainnet':
      return Client.forMainnet();
    case 'previewnet':
      return Client.forPreviewnet();
  }
}

/**
 * Builds an SDK `Client` with the operator already set. Shared by this
 * module's transfer client and `hcs.ts`'s topic client so the
 * ECDSA-vs-ED25519 key parse (`parseOperatorKey`, the footgun that nearly
 * ended the project — see AGENTS.md) happens in exactly one place rather
 * than once per Hedera service this adapter speaks to.
 */
export function makeSdkClient(config: HederaSdkClientConfig): Client {
  const client = forNetwork(config.network ?? 'testnet');
  client.setOperator(
    AccountId.fromString(config.operatorId),
    parseOperatorKey(config.operatorKey, config.keyType),
  );
  return client;
}

/**
 * The real adapter: a thin wrapper over `@hashgraph/sdk`'s `TransferTransaction`.
 * Not unit-tested directly (per the issue: don't test the Hedera SDK itself) —
 * exercised by `scripts/spike.ts` against live testnet once credentials exist.
 */
export function createHederaSdkTransferClient(config: HederaSdkClientConfig): HederaTransferClient {
  const operatorId = AccountId.fromString(config.operatorId);
  const client = makeSdkClient(config);

  return {
    async transferHbar({ toAccountId, amountHbar, memo }) {
      let tx = new TransferTransaction()
        .addHbarTransfer(operatorId, new Hbar(-amountHbar))
        .addHbarTransfer(AccountId.fromString(toAccountId), new Hbar(amountHbar));
      if (memo) {
        tx = tx.setTransactionMemo(memo);
      }
      const response = await tx.freezeWith(client).execute(client);
      // We only need node-level acceptance here: `confirm()` (mirror node
      // poll) is what proves consensus finality for the demo's settlement
      // claim, so we deliberately don't also await `getReceipt` finality.
      return { txId: response.transactionId.toString() };
    },
    close() {
      client.close();
    },
  };
}

/**
 * The transfer client seam. `createHederaPaymentsPort` (payments.ts) depends
 * only on this interface, never on `@hashgraph/sdk` directly, so unit tests
 * can drive an obviously-named fake instead of a live testnet account.
 */

import { AccountId, Client, Hbar, PrivateKey, TransferTransaction } from '@hashgraph/sdk';

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
};

function makeClient(network: HederaNetwork): Client {
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
 * The real adapter: a thin wrapper over `@hashgraph/sdk`'s `TransferTransaction`.
 * Not unit-tested directly (per the issue: don't test the Hedera SDK itself) —
 * exercised by `scripts/spike.ts` against live testnet once credentials exist.
 */
export function createHederaSdkTransferClient(config: HederaSdkClientConfig): HederaTransferClient {
  const network = config.network ?? 'testnet';
  const operatorId = AccountId.fromString(config.operatorId);
  // `PrivateKey.fromString` auto-detects DER-encoded ED25519 vs ECDSA, which
  // covers both key formats the Hedera testnet portal hands out. Unverified
  // against a live account: flag this as the first thing to check once
  // credentials land (see README "Unproven").
  const operatorKey = PrivateKey.fromString(config.operatorKey);

  const client = makeClient(network);
  client.setOperator(operatorId, operatorKey);

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

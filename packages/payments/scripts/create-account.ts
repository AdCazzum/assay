#!/usr/bin/env tsx
/**
 * Creates a second Hedera testnet account, funded from the operator.
 *
 *   pnpm --filter @assay/payments exec tsx scripts/create-account.ts
 *
 * ## Why this exists
 *
 * Every payment and bond in this project used to be a self-transfer, because
 * only one funded testnet account existed. That is weak in two separate ways,
 * and the second one is not obvious:
 *
 * 1. Nothing of value actually moves. The amount nets out and only the node
 *    fee leaves the account, so "real value moved on Hedera" is doing a lot of
 *    work for a transaction that returned the money to itself.
 * 2. **The mirror node reports a self-transfer as only the fee movement.** The
 *    payment amount does not appear in the transfer list at all, because sender
 *    and receiver cancel. So `confirmPayment`'s amount check (see
 *    `../src/payments.ts`) can never pass on one: it sums transfers to the
 *    payee and finds a small negative number, the fee.
 *
 * That second point was found by running the live loop after the payment gate
 * started verifying amounts. Every unit test passed, because the fakes model a
 * transfer that does not net out. Only the real mirror node shows it.
 *
 * The account id goes in `.env` as `HEDERA_PAY_TO_ACCOUNT_ID`,
 * `HEDERA_BOND_ACCOUNT_ID` and `HEDERA_CHALLENGER_ACCOUNT_ID`. This script does
 * not print the new account's private key, and nothing in this repo needs it:
 * the account only ever receives.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { AccountCreateTransaction, AccountId, Client, Hbar, PrivateKey } from '@hashgraph/sdk';
import { parseOperatorKey, type HederaKeyType } from '../src/operator-key.js';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../..');
loadEnv({ path: path.join(repoRoot, '.env') });

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`missing ${key}. Set it in ${path.join(repoRoot, '.env')} (see .env.example).`);
  }
  return value;
}

async function main(): Promise<void> {
  const operatorId = AccountId.fromString(requireEnv('HEDERA_OPERATOR_ID'));
  const operatorKey = parseOperatorKey(
    requireEnv('HEDERA_OPERATOR_KEY'),
    process.env.HEDERA_KEY_TYPE as HederaKeyType | undefined,
  );
  const initialHbar = Number(process.env.CREATE_ACCOUNT_HBAR ?? '20');

  const client = Client.forTestnet().setOperator(operatorId, operatorKey);
  try {
    console.log(`[create-account] funding a new account with ${initialHbar} HBAR from ${operatorId.toString()}...`);
    const response = await new AccountCreateTransaction()
      .setKeyWithoutAlias(PrivateKey.generateECDSA().publicKey)
      .setInitialBalance(new Hbar(initialHbar))
      .execute(client);
    const receipt = await response.getReceipt(client);

    console.log(`[create-account] created ${receipt.accountId?.toString()}`);
    console.log(`[create-account] tx: https://hashscan.io/testnet/transaction/${response.transactionId.toString()}`);
    console.log('');
    console.log('Add to .env:');
    console.log(`  HEDERA_PAY_TO_ACCOUNT_ID=${receipt.accountId?.toString()}`);
    console.log(`  HEDERA_BOND_ACCOUNT_ID=${receipt.accountId?.toString()}`);
    console.log(`  HEDERA_CHALLENGER_ACCOUNT_ID=${receipt.accountId?.toString()}`);
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(`[create-account] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

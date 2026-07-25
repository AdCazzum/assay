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
 * ## Keep the key
 *
 * An earlier version of this script discarded the new account's private key, on
 * the reasoning that an account which only ever receives has no need for one.
 * That is true in isolation and wrong in context: every payment, bond and slash
 * moves HBAR one way, so the payee accumulates a balance and the operator
 * drains at roughly 90 HBAR per rehearsal cycle. Without the key that balance
 * is unrecoverable, and ~856 HBAR duly stranded before anyone noticed.
 *
 * So the key is written to `.env` alongside the id, and `sweep-payee.ts` uses it
 * to send the balance back. It is written to the file rather than printed, so it
 * does not end up in a terminal scrollback or a transcript.
 *
 * Writes `HEDERA_PAY_TO_ACCOUNT_ID`, `HEDERA_BOND_ACCOUNT_ID`,
 * `HEDERA_CHALLENGER_ACCOUNT_ID` and `HEDERA_PAY_TO_ACCOUNT_KEY`. Pass
 * `--print-env` to print the lines instead of writing them.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { readFileSync, writeFileSync } from 'node:fs';
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
    const key = PrivateKey.generateECDSA();
    const response = await new AccountCreateTransaction()
      .setKeyWithoutAlias(key.publicKey)
      .setInitialBalance(new Hbar(initialHbar))
      .execute(client);
    const receipt = await response.getReceipt(client);
    const id = receipt.accountId?.toString();
    if (!id) {
      throw new Error('account creation returned no account id');
    }

    console.log(`[create-account] created ${id}`);
    console.log(`[create-account] tx: https://hashscan.io/testnet/transaction/${response.transactionId.toString()}`);

    const assignments: Array<[string, string]> = [
      ['HEDERA_PAY_TO_ACCOUNT_ID', id],
      ['HEDERA_BOND_ACCOUNT_ID', id],
      ['HEDERA_CHALLENGER_ACCOUNT_ID', id],
      ['HEDERA_PAY_TO_ACCOUNT_KEY', key.toStringRaw()],
    ];

    if (process.argv.includes('--print-env')) {
      // Explicitly asked for, so the key goes to stdout. Mind the scrollback.
      console.log('');
      for (const [k, v] of assignments) console.log(`${k}=${v}`);
      return;
    }

    const envPath = path.join(repoRoot, '.env');
    let env = readFileSync(envPath, 'utf8');
    for (const [k, v] of assignments) {
      env = new RegExp(`^${k}=.*$`, 'm').test(env)
        ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`)
        : `${env.replace(/\n*$/, '')}\n${k}=${v}\n`;
    }
    writeFileSync(envPath, env);
    console.log(`[create-account] wrote id and key to ${envPath} (key not printed)`);
    console.log('[create-account] sweep its balance back with scripts/sweep-payee.ts');
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(`[create-account] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

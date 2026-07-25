#!/usr/bin/env tsx
/**
 * Sends the payee account's balance back to the operator.
 *
 *   pnpm --filter @assay/payments exec tsx scripts/sweep-payee.ts
 *
 * ## Why this exists
 *
 * Every payment, bond and slash in this project moves HBAR **one way**, from
 * the operator to the payee, and nothing sends it back. A full rehearsal cycle
 * costs the operator around 90 HBAR (a reset posts two 30 HBAR bonds, the demo
 * pays 5 and bonds 20 more for the challenge preamble), so the operator drains
 * while the payee accumulates a balance nothing can spend.
 *
 * The first payee account was created without keeping its key, on the
 * reasoning that an account which only ever receives has no need for one. That
 * reasoning is correct in isolation and wrong in context: without the key the
 * balance is unrecoverable, so ~856 HBAR stranded there and the operator had to
 * be refilled from the portal instead. This script is why the current payee's
 * key is kept in `.env` as `HEDERA_PAY_TO_ACCOUNT_KEY`.
 *
 * The portal's daily refill and its Refill button both still work, and are the
 * right answer if you are simply out. This is for not needing them mid-session.
 *
 * Leaves a small reserve behind so the payee can still pay its own transaction
 * fee. Override with `SWEEP_RESERVE_HBAR`.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { AccountId, Client, Hbar, TransferTransaction } from '@hashgraph/sdk';
import { parseOperatorKey, type HederaKeyType } from '../src/operator-key.js';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../..');
loadEnv({ path: path.join(repoRoot, '.env') });

const MIRROR_NODE = process.env.HEDERA_MIRROR_NODE_URL ?? 'https://testnet.mirrornode.hedera.com';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `missing ${key}. Set it in ${path.join(repoRoot, '.env')} (see .env.example). ` +
        'A payee created before HEDERA_PAY_TO_ACCOUNT_KEY existed cannot be swept: its key was never kept.',
    );
  }
  return value;
}

async function balanceHbar(accountId: string): Promise<number> {
  const res = await fetch(`${MIRROR_NODE}/api/v1/accounts/${accountId}`);
  if (!res.ok) {
    throw new Error(`could not read account ${accountId} from the mirror node (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { balance?: { balance?: number } };
  return (body.balance?.balance ?? 0) / 1e8;
}

async function main(): Promise<void> {
  const operatorId = requireEnv('HEDERA_OPERATOR_ID');
  const payeeId = requireEnv('HEDERA_PAY_TO_ACCOUNT_ID');
  const payeeKey = parseOperatorKey(
    requireEnv('HEDERA_PAY_TO_ACCOUNT_KEY'),
    process.env.HEDERA_PAY_TO_KEY_TYPE as HederaKeyType | undefined,
  );
  const reserve = Number(process.env.SWEEP_RESERVE_HBAR ?? '1');

  const before = await balanceHbar(payeeId);
  const amount = Math.floor((before - reserve) * 1e8) / 1e8;
  console.log(`[sweep] payee ${payeeId} holds ${before} HBAR, reserving ${reserve}`);

  if (amount <= 0) {
    console.log('[sweep] nothing to sweep.');
    return;
  }

  // The payee signs, since it is the one paying out. Its key is only ever used
  // here, which is the whole reason it is kept.
  const client = Client.forTestnet().setOperator(AccountId.fromString(payeeId), payeeKey);
  try {
    console.log(`[sweep] sending ${amount} HBAR: ${payeeId} -> ${operatorId}...`);
    const response = await new TransferTransaction()
      .addHbarTransfer(AccountId.fromString(payeeId), new Hbar(-amount))
      .addHbarTransfer(AccountId.fromString(operatorId), new Hbar(amount))
      .setTransactionMemo('assay sweep payee -> operator')
      .execute(client);
    const receipt = await response.getReceipt(client);
    console.log(`[sweep] ${receipt.status.toString()}`);
    console.log(`[sweep] tx: https://hashscan.io/testnet/transaction/${response.transactionId.toString()}`);
    console.log(`[sweep] operator now holds ${await balanceHbar(operatorId)} HBAR`);
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(`[sweep] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

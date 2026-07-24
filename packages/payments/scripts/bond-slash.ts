#!/usr/bin/env tsx
/**
 * The live round trip issue #7 asks for: post a bond, then slash part of it
 * to a challenger, each confirmed via the mirror node. Mirrors
 * `scripts/spike.ts` (same env, same preflight, same output shape) so the
 * two scripts read as one family of evidence rather than two ad hoc tools.
 *
 * Run: pnpm --filter @assay/payments exec tsx scripts/bond-slash.ts
 *
 * Requires the same `.env` as spike.ts:
 *   HEDERA_OPERATOR_ID=0.0.xxxxx
 *   HEDERA_OPERATOR_KEY=...
 *   HEDERA_NETWORK=testnet   (optional, defaults to testnet)
 *
 * Optional:
 *   SPIKE_BOND_ACCOUNT_ID       where postBond deposits to. Defaults to the
 *                               operator's own account (a self-transfer): there
 *                               is no separate bond-escrow account provisioned
 *                               for this build (SPEC.md §17 rules out a real
 *                               staking/escrow protocol).
 *   SPIKE_CHALLENGER_ACCOUNT_ID who slash pays out to. Defaults to the
 *                               operator's own account for the same reason:
 *                               there is only one funded testnet account.
 *                               This proves the transaction path (a real
 *                               transfer lands and confirms), not the
 *                               economics of paying an independent challenger
 *                               — say so plainly wherever this output is used.
 *   SPIKE_BOND_AMOUNT_HBAR      total bond, defaults to 0.02.
 *   SPIKE_SLASH_AMOUNT_HBAR    portion of the bond slashed to the challenger,
 *                               defaults to half the bond (0.01). Must be
 *                               <= the bond amount; this script does not
 *                               enforce that against the live balance, it's
 *                               just picking a plausible "partial slash".
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

import { createHederaPaymentsPort } from '../src/payments.js';
import { createHederaSdkTransferClient } from '../src/hedera-client.js';
import type { HederaNetwork } from '../src/hedera-client.js';
import { assertKeyMatchesAccount, parseOperatorKey, type HederaKeyType } from '../src/operator-key.js';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../..');
dotenv.config({ path: path.join(repoRoot, '.env') });

const MIRROR_NODE_BASE_URL: Record<HederaNetwork, string> = {
  testnet: 'https://testnet.mirrornode.hedera.com',
  mainnet: 'https://mainnet-public.mirrornode.hedera.com',
  previewnet: 'https://previewnet.mirrornode.hedera.com',
};

/** Raised for bad/missing input. Caught at the bottom and printed without a stack trace. */
class BondSlashInputError extends Error {}

function readConfig() {
  const operatorId = process.env.HEDERA_OPERATOR_ID;
  const operatorKey = process.env.HEDERA_OPERATOR_KEY;
  const network = (process.env.HEDERA_NETWORK ?? 'testnet') as HederaNetwork;

  if (!operatorId || !operatorKey) {
    throw new BondSlashInputError(
      'missing HEDERA_OPERATOR_ID / HEDERA_OPERATOR_KEY.\n' +
        `  Add them to ${path.join(repoRoot, '.env')} (see .env.example) once the\n` +
        '  Hedera testnet operator account exists, then re-run this script.',
    );
  }
  if (network !== 'testnet') {
    throw new BondSlashInputError(`HEDERA_NETWORK="${network}" is not "testnet". This script only ever targets testnet.`);
  }

  const bondAmountHbar = Number(process.env.SPIKE_BOND_AMOUNT_HBAR ?? '0.02');
  const slashAmountHbar = Number(process.env.SPIKE_SLASH_AMOUNT_HBAR ?? String(bondAmountHbar / 2));

  if (slashAmountHbar > bondAmountHbar) {
    throw new BondSlashInputError(
      `SPIKE_SLASH_AMOUNT_HBAR (${slashAmountHbar}) is greater than SPIKE_BOND_AMOUNT_HBAR (${bondAmountHbar}).`,
    );
  }

  return {
    operatorId,
    operatorKey,
    network,
    keyType: process.env.HEDERA_KEY_TYPE as HederaKeyType | undefined,
    bondAccountId: process.env.SPIKE_BOND_ACCOUNT_ID || operatorId,
    challengerAccountId: process.env.SPIKE_CHALLENGER_ACCOUNT_ID || operatorId,
    bondAmountHbar,
    slashAmountHbar,
  };
}

async function main(): Promise<boolean> {
  const { operatorId, operatorKey, network, keyType, bondAccountId, challengerAccountId, bondAmountHbar, slashAmountHbar } =
    readConfig();

  const parsedKey = parseOperatorKey(operatorKey, keyType);
  await assertKeyMatchesAccount({
    accountId: operatorId,
    key: parsedKey,
    mirrorNodeBaseUrl: MIRROR_NODE_BASE_URL[network],
  });
  console.log(`[bond-slash] operator key verified against ${operatorId}`);

  if (bondAccountId === operatorId && challengerAccountId === operatorId) {
    console.log(
      '[bond-slash] NOTE: only one funded testnet account exists, so both postBond and slash ' +
        'are self-transfers back to the operator. This proves the transaction path (a real bond ' +
        'deposit and a real slash payout each land and confirm on testnet), not the economics of ' +
        'an independent bond-escrow account or challenger.',
    );
  }

  const client = createHederaSdkTransferClient({ operatorId, operatorKey, network, keyType });

  // `onConfirmAttempt` is one callback shared across every `confirm()` call
  // this port ever makes. Since the bond and slash confirms run strictly in
  // sequence (never concurrently), a single mutable pointer to "wherever the
  // current phase logs its attempts" is enough to keep them apart.
  let currentAttempts: string[] = [];
  const port = createHederaPaymentsPort({
    client,
    payToAccountId: operatorId,
    bondAccountId,
    mirrorNodeBaseUrl: MIRROR_NODE_BASE_URL[network],
    fetchImpl: fetch,
    onConfirmAttempt: (info) => {
      currentAttempts.push(`  poll #${info.attempt} at ${info.elapsedMs}ms: ${info.state}`);
    },
  });

  try {
    console.log(`[bond-slash] posting bond: ${bondAmountHbar} HBAR, ${operatorId} -> ${bondAccountId}`);
    const bondAttempts: string[] = [];
    currentAttempts = bondAttempts;
    const bondStart = Date.now();
    const { bondRef, txId: bondTxId } = await port.postBond(bondAmountHbar);
    console.log(`[bond-slash] bond submitted, bondRef=${bondRef} txId=${bondTxId}`);
    console.log('[bond-slash] polling mirror node for bond finality...');

    const bondConfirmed = await port.confirm(bondTxId);
    const bondElapsedMs = Date.now() - bondStart;
    console.log(bondAttempts.join('\n'));
    console.log(`[bond-slash] bond confirmed=${bondConfirmed} settle_time_ms=${bondElapsedMs}`);
    console.log(`[bond-slash] HashScan (bond): https://hashscan.io/${network}/transaction/${bondTxId}`);

    if (!bondConfirmed) {
      return false;
    }

    console.log(
      `[bond-slash] slashing ${slashAmountHbar} of ${bondAmountHbar} HBAR bond to challenger: ${bondAccountId} -> ${challengerAccountId}`,
    );
    const slashAttempts: string[] = [];
    currentAttempts = slashAttempts;
    const slashStart = Date.now();
    const { txId: slashTxId } = await port.slash(bondRef, challengerAccountId);
    console.log(`[bond-slash] slash submitted, txId=${slashTxId}`);
    console.log('[bond-slash] polling mirror node for slash finality...');

    const slashConfirmed = await port.confirm(slashTxId);
    const slashElapsedMs = Date.now() - slashStart;
    console.log(slashAttempts.join('\n'));
    console.log(`[bond-slash] slash confirmed=${slashConfirmed} settle_time_ms=${slashElapsedMs}`);
    console.log(`[bond-slash] HashScan (slash): https://hashscan.io/${network}/transaction/${slashTxId}`);

    return bondConfirmed && slashConfirmed;
  } finally {
    client.close();
  }
}

main()
  .then((confirmed) => {
    process.exit(confirmed ? 0 : 1);
  })
  .catch((err) => {
    console.error(`[bond-slash] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

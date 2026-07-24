#!/usr/bin/env tsx
/**
 * The real round trip this package's spike is supposed to prove: pay a tiny
 * amount of testnet HBAR, confirm it via the mirror node, print how long
 * settlement took and a HashScan link to look at it.
 *
 * Run: pnpm --filter @assay/payments exec tsx scripts/spike.ts
 *
 * Requires a `.env` at the repo root (see `.env.example`) with:
 *   HEDERA_OPERATOR_ID=0.0.xxxxx
 *   HEDERA_OPERATOR_KEY=...
 *   HEDERA_NETWORK=testnet   (optional, defaults to testnet)
 *
 * Optional:
 *   SPIKE_PAY_TO_ACCOUNT_ID  defaults to the operator's own account (a
 *                            self-transfer), since there is no second
 *                            testnet account provisioned for this spike.
 *   SPIKE_AMOUNT_HBAR        defaults to 0.01
 *
 * This has not been run against live testnet yet: there is no `.env` in this
 * repo (see README.md "Unproven"). It fails with a clear one-line message and
 * exit code 1, not a stack trace, when the env is missing.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

import { createHederaPaymentsPort } from '../src/payments.js';
import { createHederaSdkTransferClient } from '../src/hedera-client.js';
import type { HederaNetwork } from '../src/hedera-client.js';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../..');
dotenv.config({ path: path.join(repoRoot, '.env') });

const MIRROR_NODE_BASE_URL: Record<HederaNetwork, string> = {
  testnet: 'https://testnet.mirrornode.hedera.com',
  mainnet: 'https://mainnet-public.mirrornode.hedera.com',
  previewnet: 'https://previewnet.mirrornode.hedera.com',
};

/** Raised for bad/missing input. Caught at the bottom and printed without a stack trace. */
class SpikeInputError extends Error {}

function readConfig() {
  const operatorId = process.env.HEDERA_OPERATOR_ID;
  const operatorKey = process.env.HEDERA_OPERATOR_KEY;
  const network = (process.env.HEDERA_NETWORK ?? 'testnet') as HederaNetwork;

  if (!operatorId || !operatorKey) {
    throw new SpikeInputError(
      'missing HEDERA_OPERATOR_ID / HEDERA_OPERATOR_KEY.\n' +
        `  Add them to ${path.join(repoRoot, '.env')} (see .env.example) once the\n` +
        '  Hedera testnet operator account exists, then re-run this script.',
    );
  }
  if (network !== 'testnet') {
    // The spike is specifically about testnet; refuse to run elsewhere by accident.
    throw new SpikeInputError(`HEDERA_NETWORK="${network}" is not "testnet". This spike only ever targets testnet.`);
  }

  return {
    operatorId,
    operatorKey,
    network,
    payToAccountId: process.env.SPIKE_PAY_TO_ACCOUNT_ID || operatorId,
    amountHbar: Number(process.env.SPIKE_AMOUNT_HBAR ?? '0.01'),
  };
}

async function main(): Promise<boolean> {
  const { operatorId, operatorKey, network, payToAccountId, amountHbar } = readConfig();
  const requestHash = `spike-${Date.now()}`;

  const client = createHederaSdkTransferClient({ operatorId, operatorKey, network });
  const attempts: string[] = [];
  const port = createHederaPaymentsPort({
    client,
    payToAccountId,
    bondAccountId: payToAccountId,
    mirrorNodeBaseUrl: MIRROR_NODE_BASE_URL[network],
    fetchImpl: fetch,
    onConfirmAttempt: (info) => {
      attempts.push(`  poll #${info.attempt} at ${info.elapsedMs}ms: ${info.state}`);
    },
  });

  try {
    console.log(`[spike] paying ${amountHbar} HBAR: ${operatorId} -> ${payToAccountId}`);
    console.log(`[spike] requestHash (memo): ${requestHash}`);

    const { txId } = await port.pay(amountHbar, requestHash);
    console.log(`[spike] submitted, txId=${txId}`);
    console.log('[spike] polling mirror node for finality...');

    const start = Date.now();
    const confirmed = await port.confirm(txId);
    const elapsedMs = Date.now() - start;

    console.log(attempts.join('\n'));
    console.log(`[spike] confirmed=${confirmed} settle_time_ms=${elapsedMs}`);
    console.log(`[spike] HashScan: https://hashscan.io/${network}/transaction/${txId}`);

    return confirmed;
  } finally {
    client.close();
  }
}

main()
  .then((confirmed) => {
    process.exit(confirmed ? 0 : 1);
  })
  .catch((err) => {
    console.error(`[spike] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

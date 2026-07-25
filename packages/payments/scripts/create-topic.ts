#!/usr/bin/env tsx
/**
 * Creates the Hedera Consensus Service topic the loop's audit trail is
 * anchored to, and writes its id to `.env` as `HEDERA_LOOP_TOPIC_ID`.
 *
 *   pnpm --filter @assay/payments exec tsx scripts/create-topic.ts
 *
 * ## Why this exists
 *
 * `apps/mcp/src/loop-anchor.ts` has the full argument. The short version: the
 * NDJSON event log is the one artefact this project asks an audience to
 * believe rather than check. A SHA-256 chain over its lines, with the head
 * submitted to this topic at the loop's turning points, makes the log
 * tamper-evident against consensus ordering that we do not control.
 *
 * ## No submit key, on purpose
 *
 * The topic is created without one, so anyone can write to it. That sounds
 * wrong for an audit trail and is not: the anchors are self-authenticating.
 * A record only means something if its `chain` value actually reproduces from
 * the log file, and a stranger cannot forge one for a log they do not have.
 * Noise on the topic is noise the verifier skips; what it cannot be is a
 * *replacement* for an anchor already stamped at consensus. A submit key
 * would instead mean the operator can rotate who may attest, which is a trust
 * assumption the project would then have to disclose. Nothing here is worth
 * that.
 *
 * The one thing a submit key would buy is preventing a spammer from burying
 * the real anchors. `verify-anchors.ts` filters by shape and by chain match,
 * so burying costs the reader a longer page fetch, not correctness.
 *
 * Pass `--print-env` to print the line instead of writing it.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { readFileSync, writeFileSync } from 'node:fs';

import { createHederaSdkTopicClient } from '../src/hcs.js';
import type { HederaKeyType } from '../src/operator-key.js';
import type { HederaNetwork } from '../src/hedera-client.js';

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
  const network = (process.env.HEDERA_NETWORK ?? 'testnet') as HederaNetwork;
  const client = createHederaSdkTopicClient({
    operatorId: requireEnv('HEDERA_OPERATOR_ID'),
    operatorKey: requireEnv('HEDERA_OPERATOR_KEY'),
    network,
    keyType: process.env.HEDERA_KEY_TYPE as HederaKeyType | undefined,
  });

  try {
    console.log(`[create-topic] creating an HCS topic on ${network}...`);
    const started = Date.now();
    const { topicId } = await client.createTopic('assay loop audit anchors (sha256 chain heads)');
    console.log(`[create-topic] created ${topicId} in ${Date.now() - started}ms`);
    console.log(`[create-topic] hashscan: https://hashscan.io/${network}/topic/${topicId}`);
    console.log(
      `[create-topic] mirror node: https://${network}.mirrornode.hedera.com/api/v1/topics/${topicId}/messages`,
    );

    if (process.argv.includes('--print-env')) {
      console.log('');
      console.log(`HEDERA_LOOP_TOPIC_ID=${topicId}`);
      return;
    }

    const envPath = path.join(repoRoot, '.env');
    const line = `HEDERA_LOOP_TOPIC_ID=${topicId}`;
    const existing = readFileSync(envPath, 'utf8');
    const pattern = /^HEDERA_LOOP_TOPIC_ID=.*$/m;
    writeFileSync(
      envPath,
      pattern.test(existing)
        ? existing.replace(pattern, line)
        : `${existing.replace(/\n*$/, '')}\n${line}\n`,
    );
    console.log(`[create-topic] wrote ${line} to ${envPath}`);
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(`[create-topic] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

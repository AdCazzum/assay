#!/usr/bin/env tsx
/**
 * Live evidence for the consensus anchor: drives the real sink, the real
 * anchor and the real Hedera topic client against testnet, exactly the way
 * `src/index.ts` wires them, and leaves the anchors on a public topic for
 * `verify-anchors.ts` to check.
 *
 *   pnpm --filter @assay/mcp exec tsx scripts/live-anchor-check.ts
 *
 * Needs `.env` at the repo root with `HEDERA_OPERATOR_*` and
 * `HEDERA_LOOP_TOPIC_ID` (create one with
 * `pnpm --filter @assay/payments exec tsx scripts/create-topic.ts`).
 *
 * ## Why this exists rather than trusting the unit tests
 *
 * AGENTS.md's standing lesson: "unit tests pass on things the chain does not
 * do." `loop-anchor.test.ts` drives a fake topic client, which models the
 * configured happy path — the same class of fake that let the payment gate,
 * the event sink and the default provider list all ship green and break on
 * first contact with the network. The parts only a live run can establish are
 * that the operator key actually signs a `TopicMessageSubmitTransaction`,
 * that the receipt carries the sequence number this code reads off it, that
 * a ~100-byte anchor stays inside one consensus message, and that what the
 * mirror node hands back base64-decodes into the record the verifier expects.
 *
 * It spends no HBAR beyond the consensus-message fees (a handful of
 * thousandths of a cent) — no payment, no bond, no slash. The loop events
 * below are synthetic and obviously so; this is a check on the anchoring
 * path, not a rehearsal of the demo.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { config as loadEnv } from 'dotenv';
import { createEventStamper } from '@assay/core';
import {
  createHederaSdkTopicClient,
  type HederaKeyType,
  type HederaNetwork,
} from '@assay/payments';

import { createLoopAnchor } from '../src/loop-anchor.js';
import { createLoopEventSink } from '../src/loop-event-sink.js';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../..');
loadEnv({ path: path.join(repoRoot, '.env') });

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`missing ${key} (see .env.example)`);
  return value;
}

async function main(): Promise<void> {
  const network = (process.env.HEDERA_NETWORK ?? 'testnet') as HederaNetwork;
  const topicId = requireEnv('HEDERA_LOOP_TOPIC_ID');
  const sinkPath = path.join(mkdtempSync(path.join(tmpdir(), 'assay-live-anchor-')), 'events.ndjson');

  const client = createHederaSdkTopicClient({
    operatorId: requireEnv('HEDERA_OPERATOR_ID'),
    operatorKey: requireEnv('HEDERA_OPERATOR_KEY'),
    network,
    keyType: process.env.HEDERA_KEY_TYPE as HederaKeyType | undefined,
  });

  const anchor = createLoopAnchor({
    client,
    topicId,
    onPublished: ({ record, sequenceNumber, elapsedMs }) =>
      console.log(
        `  anchored seq ${record.from}-${record.seq} (${record.step}) -> topic message ` +
          `#${sequenceNumber} in ${elapsedMs}ms  ${record.chain.slice(0, 16)}...`,
      ),
    onError: (err, record) =>
      console.error(`  FAILED at seq ${record.seq} (${record.step}): ${err.message}`),
  });

  const stamp = createEventStamper();
  const sink = createLoopEventSink(sinkPath, stamp, { onAnchor: (r) => anchor.anchor(r) });

  console.log(`topic:  ${topicId} on ${network}`);
  console.log(`sink:   ${sinkPath}`);
  console.log('');
  console.log('emitting a synthetic loop (no HBAR moves; only the anchors are real)...');

  // The shape of a real run: a discovery that is not anchored, a payment whose
  // confirm polls collapse into one anchor, then each truth-settling step.
  sink.sinkLoopEvent(
    stamp({ step: 'discover', outcome: 'ok', name: 'rugscore.assay.eth', provider: {} as never }),
  );
  sink.sinkLoopEvent(stamp({ step: 'pay', phase: 'confirming', txId: '0.0.0@live-check' }));
  sink.sinkHeartbeat({ kind: 'heartbeat', of: 'payment-confirm', attempt: 1, elapsedMs: 900, state: 'pending' });
  sink.sinkHeartbeat({ kind: 'heartbeat', of: 'payment-confirm', attempt: 2, elapsedMs: 1900, state: 'pending' });
  sink.sinkLoopEvent(
    stamp({ step: 'pay', phase: 'paid', name: 'rugscore.assay.eth', txId: '0.0.0@live-check', amountHbar: 5 }),
  );
  sink.sinkLoopEvent(stamp({ step: 'serve', outcome: 'ok', jobId: 'live-check' } as never));
  sink.sinkLoopEvent(stamp({ step: 'challenge', outcome: 'upheld', jobId: 'live-check' } as never));
  sink.sinkLoopEvent(stamp({ step: 'verify', outcome: 'refuted', jobId: 'live-check' } as never));
  sink.sinkLoopEvent(stamp({ step: 'slash', amountHbar: 5, txId: '0.0.0@live-check' } as never));
  // Trailing lines after the last anchored step: what the `close` anchor is for.
  sink.sinkLoopEvent(stamp({ step: 'accept', jobId: 'live-check', rating: 'unsatisfied' } as never));
  sink.sinkHeartbeat({ kind: 'heartbeat', of: 'reputation-write', phase: 'writing', writeState: 'pending', elapsedMs: 4200 });

  const { promise: flushed, resolve: onFlushed } = Promise.withResolvers<void>();
  sink.close(onFlushed);
  await flushed;

  const { drained } = await anchor.close();
  client.close();

  console.log('');
  console.log(`chain head: ${sink.chainHead()}`);
  console.log(`drained:    ${drained}`);
  console.log('');
  console.log('now check it from public data only:');
  console.log(
    `  pnpm --filter @assay/mcp exec tsx scripts/verify-anchors.ts --topic ${topicId} --file ${sinkPath}`,
  );
  if (!drained) {
    throw new Error('the anchor queue did not drain: some anchors never reached consensus');
  }
}

main().catch((err) => {
  console.error(`[live-anchor-check] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

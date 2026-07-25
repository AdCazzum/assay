#!/usr/bin/env tsx
/**
 * Checks the loop's NDJSON event log against the anchors on its Hedera
 * Consensus Service topic. This is the other half of `src/loop-anchor.ts`,
 * and it is written to be run by someone who does not trust us.
 *
 *   pnpm --filter @assay/mcp exec tsx scripts/verify-anchors.ts \
 *     --topic 0.0.123456 --file .assay/loop-events.ndjson
 *
 * **It needs none of our credentials.** The mirror node's topic-message
 * endpoint is public and unauthenticated, so the only inputs are a topic id
 * (printed at the top of every demo run and in the submission) and the log
 * file itself. Defaults come from `.env` when there is one, purely as a
 * convenience for us; a judge passes both flags and reads public data.
 *
 * ## What a MATCH proves, precisely
 *
 * For each anchor, the script recomputes the SHA-256 chain from the file and
 * checks the head at that anchor's `seq`. A match means every line up to that
 * point is byte-identical to what was on disk when the anchor reached
 * consensus, in the same order, with none added or removed, because any of
 * those changes reshuffles the hash and every hash after it. The anchor's
 * consensus timestamp is Hedera's, not ours, so it also fixes *when* that
 * state existed. What it does not prove is that the events were true when
 * written; that is what the claim verifier and The Graph are for. This proves
 * only that the record was not edited afterwards, which is the part that was
 * previously taken on faith.
 *
 * ## Why anchors are paired to runs by id, not by hash alone
 *
 * The sink opens the file append-only and the topic id lives in `.env`, so the
 * normal case is one topic carrying anchors from many runs while any given
 * file holds a subset of them. An earlier version matched an anchor to
 * whichever segment reproduced it and called the rest mismatches, which meant
 * the second run against a topic reported six failures for a log that was
 * perfectly intact. That is worse than useless: it teaches the reader to
 * ignore MISMATCH, which is the one word here that has to mean something.
 *
 * So every run writes a header line carrying a random run id, and every anchor
 * carries the same id. An anchor whose run is not in this file is skipped and
 * counted separately; an anchor whose run *is* in this file and does not
 * reproduce is a genuine mismatch and fails the run. Routine and accusation
 * now look different.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';

import {
  advanceChain,
  ANCHOR_GENESIS,
  ANCHOR_VERSION,
  RUN_LINE_KIND,
  type LoopAnchorRecord,
} from '../src/loop-anchor.js';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../..');
loadEnv({ path: path.join(repoRoot, '.env') });

const MIRROR_NODE_BASE_URL: Record<string, string> = {
  testnet: 'https://testnet.mirrornode.hedera.com',
  mainnet: 'https://mainnet-public.mirrornode.hedera.com',
  previewnet: 'https://previewnet.mirrornode.hedera.com',
};

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** The two fields the verifier reads off a log line. Narrowed, never cast: a
 * silently-undefined `seq` would make every chain lookup miss and every anchor
 * look like tampering. */
function readLine(json: string): { seq: number; runId?: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // A truncated final line (the process was killed mid-write) is the one
    // realistic case, and it cannot be part of a chain the sink completed.
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  if (!('seq' in parsed) || typeof parsed.seq !== 'number') return undefined;
  const seq = parsed.seq;
  if (
    'kind' in parsed &&
    parsed.kind === RUN_LINE_KIND &&
    'run' in parsed &&
    typeof parsed.run === 'string'
  ) {
    return { seq, runId: parsed.run };
  }
  return { seq };
}

type RunSegment = {
  index: number;
  /** Empty for lines that precede the first run header, i.e. runs written before anchoring existed. */
  runId: string;
  firstSeq: number;
  lastSeq: number;
  lineCount: number;
  /** Chain head keyed by the `seq` of the line that produced it. */
  headBySeq: Map<number, string>;
};

function segmentRuns(lines: string[]): RunSegment[] {
  const segments: RunSegment[] = [];
  let current: RunSegment | undefined;
  let chain = ANCHOR_GENESIS;

  const start = (runId: string, seq: number): RunSegment => {
    chain = ANCHOR_GENESIS;
    const segment: RunSegment = {
      index: segments.length + 1,
      runId,
      firstSeq: seq,
      lastSeq: seq,
      lineCount: 0,
      headBySeq: new Map(),
    };
    segments.push(segment);
    return segment;
  };

  for (const line of lines) {
    const read = readLine(line);
    if (!read) continue;
    if (read.runId !== undefined || !current) {
      current = start(read.runId ?? '', read.seq);
    }
    chain = advanceChain(chain, line);
    current.lastSeq = read.seq;
    current.lineCount += 1;
    current.headBySeq.set(read.seq, chain);
  }

  return segments;
}

type TopicMessage = { consensus_timestamp: string; sequence_number: number; message: string };

async function fetchTopicMessages(baseUrl: string, topicId: string): Promise<TopicMessage[]> {
  const all: TopicMessage[] = [];
  let next: string | undefined = `/api/v1/topics/${topicId}/messages?limit=100&order=asc`;
  while (next) {
    const res: Response = await fetch(`${baseUrl}${next}`);
    if (!res.ok) {
      throw new Error(`mirror node returned HTTP ${res.status} for ${next}`);
    }
    const body = (await res.json()) as { messages?: TopicMessage[]; links?: { next?: string | null } };
    all.push(...(body.messages ?? []));
    next = body.links?.next ?? undefined;
  }
  return all;
}

function parseAnchor(message: TopicMessage): LoopAnchorRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(message.message, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
  // Shape-filtered rather than trusted: the topic has no submit key (see
  // create-topic.ts on why that is safe), so anyone may post anything to it.
  // Junk is skipped; it cannot displace an anchor that already reached
  // consensus.
  if (!parsed || typeof parsed !== 'object') return undefined;
  const r = parsed as Partial<LoopAnchorRecord>;
  if (
    r.v !== ANCHOR_VERSION ||
    typeof r.run !== 'string' ||
    typeof r.seq !== 'number' ||
    typeof r.from !== 'number' ||
    typeof r.step !== 'string' ||
    typeof r.chain !== 'string'
  ) {
    return undefined;
  }
  return { v: ANCHOR_VERSION, run: r.run, seq: r.seq, from: r.from, step: r.step, chain: r.chain };
}

async function main(): Promise<void> {
  const topicId = flag('topic') ?? process.env.HEDERA_LOOP_TOPIC_ID;
  if (!topicId) {
    throw new Error('no topic. Pass --topic 0.0.x, or set HEDERA_LOOP_TOPIC_ID in .env.');
  }
  const network = flag('network') ?? process.env.HEDERA_NETWORK ?? 'testnet';
  const baseUrl =
    flag('mirror-node') ?? process.env.HEDERA_MIRROR_NODE_URL ?? MIRROR_NODE_BASE_URL[network];
  if (!baseUrl) {
    throw new Error(`unknown network "${network}". Pass --mirror-node <url>.`);
  }
  const filePath = path.resolve(
    repoRoot,
    flag('file') ?? process.env.ASSAY_LOOP_EVENTS_SINK ?? '.assay/loop-events.ndjson',
  );

  const lines = readFileSync(filePath, 'utf8').split('\n').filter((line) => line.length > 0);
  const segments = segmentRuns(lines);
  const byRunId = new Map(segments.filter((s) => s.runId).map((s) => [s.runId, s]));

  console.log(`file:  ${filePath}`);
  console.log(`       ${lines.length} lines, ${segments.length} run(s)`);
  for (const segment of segments) {
    console.log(
      `       run ${segment.index}: ${segment.runId || '(no run header, written before anchoring)'}` +
        `, seq ${segment.firstSeq}-${segment.lastSeq}, ${segment.lineCount} lines`,
    );
  }

  console.log(`topic: ${topicId} via ${baseUrl} (public, no credentials)`);
  const messages = await fetchTopicMessages(baseUrl, topicId);
  const anchors: Array<{ message: TopicMessage; record: LoopAnchorRecord }> = [];
  for (const message of messages) {
    const record = parseAnchor(message);
    if (record) anchors.push({ message, record });
  }
  const mine = anchors.filter((a) => byRunId.has(a.record.run));
  console.log(
    `       ${messages.length} message(s), ${anchors.length} readable anchor(s), ` +
      `${mine.length} for run(s) in this file`,
  );
  console.log('');

  if (mine.length === 0) {
    throw new Error(
      'no anchor on this topic belongs to any run in this file. Nothing was verified: ' +
        'check the topic id, or the log predates anchoring.',
    );
  }

  console.log('  msg  consensus timestamp        step       lines        run  result');
  let matched = 0;
  const matchedSeqByRun = new Map<string, number>();
  for (const { message, record } of mine) {
    const segment = byRunId.get(record.run);
    const ok = segment?.headBySeq.get(record.seq) === record.chain;
    if (ok && segment) {
      matched += 1;
      matchedSeqByRun.set(record.run, Math.max(matchedSeqByRun.get(record.run) ?? -1, record.seq));
    }
    const when = new Date(Number(message.consensus_timestamp.split('.')[0]) * 1000).toISOString();
    console.log(
      `  ${String(message.sequence_number).padEnd(4)} ${when}  ` +
        `${record.step.padEnd(10)} ${`${record.from}-${record.seq}`.padEnd(12)} ` +
        `${String(segment?.index ?? '-').padEnd(4)} ${ok ? 'MATCH' : 'MISMATCH'}`,
    );
  }

  console.log('');
  console.log(`${matched}/${mine.length} anchors reproduce from this file.`);

  // Coverage is reported separately from matching because the two fail
  // differently: a mismatch means the file was edited, whereas an uncovered
  // tail just means a run's last anchor never made it (a killed process, an
  // unreachable topic). Both are worth saying; only the first is tampering.
  for (const segment of segments) {
    const covered = matchedSeqByRun.get(segment.runId);
    if (covered === undefined) {
      console.log(`run ${segment.index}: no anchors on this topic, unverified.`);
      continue;
    }
    console.log(
      `run ${segment.index}: lines through seq ${segment.lastSeq}, ` +
        (covered >= segment.lastSeq ? 'fully covered.' : `NOT covered past seq ${covered}.`),
    );
  }

  if (matched !== mine.length) {
    throw new Error(
      `${mine.length - matched} anchor(s) do not reproduce: the file does not match what was ` +
        'committed to consensus.',
    );
  }
}

main().catch((err) => {
  console.error(`[verify-anchors] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

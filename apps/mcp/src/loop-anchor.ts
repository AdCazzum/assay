/**
 * The consensus anchor for the loop's own narration.
 *
 * **The hole this closes.** `loop-event-sink.ts` writes every `LoopEvent` to a
 * local NDJSON file. The dashboard reads it, the run sheet quotes it, and the
 * submission cites it — and it is a file on our disk that we could have
 * rewritten after the run. Every other factual claim in this project is
 * re-derivable by a stranger (`getTokenSignals` is block-pinned, the ENS
 * records are public, the Hedera transfers are on a public mirror node); the
 * narration was the one thing left that asked to be believed. That is exactly
 * the standard the project accuses subjective star ratings of failing, so it
 * should not get a pass for being ours.
 *
 * **What is anchored, and why not the events themselves.** Not the events. A
 * running SHA-256 chain over the exact serialized lines:
 *
 * ```
 * chain[0]   = sha256(GENESIS_bytes || line[0])
 * chain[n]   = sha256(chain[n-1]_bytes || line[n])
 * ```
 *
 * and only the *head* of that chain is submitted to a Hedera Consensus
 * Service topic, at the loop's turning points. Three reasons this is the
 * right shape rather than mirroring each event onto the topic:
 *
 * 1. **Cost and latency are bounded by the loop, not by the log.** A demo run
 *    writes ~120 lines (mostly payment-confirm heartbeats, several per
 *    second). Six anchors cover all of them. Publishing each line would mean
 *    ~120 confirmed submits at ~3s each, which is longer than the demo.
 * 2. **It is strictly stronger than a copy for the property that matters.**
 *    A copy on-chain proves those events existed. A chain head proves *no
 *    line was added, removed, reordered or edited* anywhere before it,
 *    including the lines between anchors, because any change reshuffles every
 *    subsequent hash. Tampering is detected at the line, not just suspected.
 * 3. **It leaks nothing.** The topic carries 64 hex characters, not the
 *    contents of a customer's job.
 *
 * The anchors in between (rather than one at the end) are what add consensus
 * *ordering*: each carries an immutable consensus timestamp, so the run's
 * shape in time is attested, not just its final digest. A log rewritten
 * afterwards cannot produce anchors that were already stamped mid-run.
 *
 * **It must never break a tool call**, same contract as the sink it hangs off
 * (see that module's doc comment). `anchor()` is fire-and-forget and returns
 * `void`: submits are serialized on a promise tail off the hot path, failures
 * go to stderr and set the anchor dead, and a dead anchor is a no-op. A
 * network partition on the topic must cost the run its audit trail, never its
 * payment.
 *
 * `apps/mcp/scripts/verify-anchors.ts` is the other half: it replays the
 * NDJSON, recomputes this chain, and compares it against the topic as read
 * from the public mirror node. That check needs none of our credentials.
 */

import { createHash } from 'node:crypto';
import type { HederaTopicClient } from '@assay/payments';

/** Chain seed. Fixed and public; the chain's value comes from the anchors, not from a secret. */
export const ANCHOR_GENESIS = '0'.repeat(64);

/**
 * Bumped if the record shape or the chain rule changes, so an old topic is
 * never misread as a new one. v2 added `run`, without which a topic shared by
 * more than one run (the normal case, since the topic id lives in `.env`)
 * cannot tell "this anchor belongs to a different run" apart from "this anchor
 * belongs to my run and my log was edited". Those must not look alike: the
 * first is routine, the second is an accusation.
 */
export const ANCHOR_VERSION = 2;

/**
 * The steps worth an anchor: the ones where value moves or a truth claim is
 * settled. `discover`, `register` and `accept` are deliberately not here —
 * they are reversible bookkeeping, they are already covered by the chain
 * (every line is), and anchoring them would spend consensus messages to
 * attest an ENS read.
 */
export const ANCHORED_STEPS: Readonly<Record<string, true>> = {
  pay: true,
  serve: true,
  challenge: true,
  verify: true,
  slash: true,
};

/** The step name used for the final anchor written by `close()`, which commits to the whole file. */
export const FINAL_ANCHOR_STEP = 'close';

/**
 * One anchor, as it goes onto the topic. Kept small and fixed-width on
 * purpose: ~100 bytes, comfortably inside a single consensus message, so an
 * anchor never arrives as several chunks the verifier would have to reassemble.
 */
export type LoopAnchorRecord = {
  v: typeof ANCHOR_VERSION;
  /**
   * Identifies the run this anchor came from. The sink writes the same id into
   * a header line at the top of each run (`RunHeaderLine`), which is what lets
   * a verifier pair an anchor with its segment of an append-only log instead
   * of guessing.
   */
  run: string;
  /** `seq` of the last line covered by `chain` (the shared stamper's counter). */
  seq: number;
  /** `seq` of the first line covered since the previous anchor. */
  from: number;
  /** The step that triggered this anchor, or `close` for the final one. */
  step: string;
  /** Chain head after the line at `seq`. */
  chain: string;
};

/**
 * The first line of every run in the log. It exists so an append-only file
 * that accumulates many runs can be split back into them exactly, rather than
 * by inferring boundaries from `seq` resetting. It is an ordinary line as far
 * as the chain is concerned: it is hashed like any other, so it is covered by
 * the run's own anchors.
 */
export type RunHeaderLine = { kind: typeof RUN_LINE_KIND; run: string };

export const RUN_LINE_KIND = 'run';

/**
 * Advances the chain by one line. `prev` is consumed as bytes (hex-decoded),
 * `line` as UTF-8 — the exact JSON text the sink writes to the file, without
 * the trailing newline, so a verifier reproduces it with a plain
 * `split('\n')`.
 */
export function advanceChain(prev: string, line: string): string {
  return createHash('sha256')
    .update(Buffer.from(prev, 'hex'))
    .update(line, 'utf8')
    .digest('hex');
}

export type LoopAnchorPublished = {
  record: LoopAnchorRecord;
  /** The topic's own consensus-assigned sequence number. */
  sequenceNumber: number;
  txId: string;
  elapsedMs: number;
};

export type LoopAnchor = {
  /**
   * Queues one anchor. Never throws, never blocks: returns as soon as the
   * record is on the tail. A dead anchor (previous submit failed) drops it.
   */
  anchor(record: LoopAnchorRecord): void;
  /**
   * Waits for the queued submits to finish, at most `timeoutMs`. Resolves
   * either way — a demo that cannot reach the topic at shutdown should still
   * shut down. Returns whether the queue actually drained, so a caller can
   * say so rather than imply a clean finish it did not observe.
   */
  close(timeoutMs?: number): Promise<{ drained: boolean }>;
};

export type LoopAnchorConfig = {
  client: HederaTopicClient;
  topicId: string;
  /** Narration hook, so a live run can report anchors as they reach consensus. */
  onPublished?(info: LoopAnchorPublished): void;
  /** Defaults to a one-line stderr warning. stdout is the MCP JSON-RPC channel; never write there. */
  onError?(err: Error, record: LoopAnchorRecord): void;
};

export function createLoopAnchor(config: LoopAnchorConfig): LoopAnchor {
  const onError =
    config.onError ??
    ((err: Error, record: LoopAnchorRecord) => {
      process.stderr.write(
        `[assay] loop anchor failed at seq ${record.seq} (${record.step}), audit trail is off: ${err.message}\n`,
      );
    });

  let dead = false;
  // Submits are serialized rather than fired in parallel: the topic assigns
  // sequence numbers at consensus, and two in-flight submits could land in
  // either order, which would put the anchors on the topic out of chain order
  // and make the verifier's job ambiguous for no benefit.
  let tail: Promise<void> = Promise.resolve();

  return {
    anchor(record) {
      if (dead) return;
      tail = tail.then(async () => {
        if (dead) return;
        const startedAt = Date.now();
        try {
          const { txId, sequenceNumber } = await config.client.submitMessage({
            topicId: config.topicId,
            message: JSON.stringify(record),
          });
          config.onPublished?.({ record, sequenceNumber, txId, elapsedMs: Date.now() - startedAt });
        } catch (err) {
          // One failure kills the anchor for the rest of the run. A chain with
          // a hole in it is worse than no chain: it invites a reader to treat
          // a gap as noise, which is precisely the cover a tamperer wants.
          dead = true;
          onError(err instanceof Error ? err : new Error(String(err)), record);
        }
      });
    },

    async close(timeoutMs = 20_000) {
      let timer: NodeJS.Timeout | undefined;
      const drained = await Promise.race([
        tail.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      return { drained };
    },
  };
}

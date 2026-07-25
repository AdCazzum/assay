/**
 * The topic client seam, the Hedera Consensus Service half of this adapter.
 *
 * Same shape and same reason as `hedera-client.ts`'s `HederaTransferClient`:
 * callers depend on this interface, never on `@hashgraph/sdk` directly, so a
 * unit test can drive an obviously-named fake instead of a live testnet
 * account. The two clients are kept separate rather than merged into one
 * "Hedera client" because they are used by different things for different
 * reasons — `PaymentsPort` moves value, this moves an audit record — and only
 * one of them is on the path of a tool call that must not fail.
 *
 * **Why HCS at all, when payments already work.** Assay's whole argument is
 * that a claim should be re-derivable rather than trusted. The loop's own
 * narration (`apps/mcp/src/loop-event-sink.ts`, the NDJSON file the dashboard
 * and the run sheet read) was the one part of the system that asked to be
 * taken on faith: it is a local file, written by us, that we could rewrite
 * after the fact. Anchoring a hash chain over that file to a consensus topic
 * closes that hole with the same standard the rest of the project holds
 * itself to. See `apps/mcp/src/loop-anchor.ts` for the chain, and
 * `apps/mcp/scripts/verify-anchors.ts` for the check that a judge can run
 * against public data with no credentials of ours.
 */

import {
  Client,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  TopicId,
} from '@hashgraph/sdk';

import { makeSdkClient, type HederaSdkClientConfig } from './hedera-client.js';

export type SubmitTopicMessageParams = {
  topicId: string;
  /**
   * UTF-8. The SDK chunks anything over ~1000 bytes into multiple consensus
   * messages, which would make a single anchor arrive as several ordered
   * fragments and complicate the verifier for no gain — every anchor this
   * repo publishes is a fixed ~100-byte record, so chunking never triggers.
   */
  message: string;
};

export type SubmitTopicMessageResult = {
  txId: string;
  /**
   * The topic's own sequence number, assigned at consensus. Read from the
   * receipt rather than guessed locally: it is the network's ordering, and
   * it is what `verify-anchors.ts` matches against the mirror node.
   */
  sequenceNumber: number;
};

export interface HederaTopicClient {
  /** Creates a topic with no submit key (anyone may write) and returns its id. */
  createTopic(memo: string): Promise<{ topicId: string }>;
  /**
   * Submits one message and waits for its receipt. Awaiting the receipt is
   * deliberate: a submit that is never confirmed is exactly the "unit tests
   * pass on things the chain does not do" failure this repo keeps hitting, and
   * an anchor nobody confirmed reaching consensus is not evidence of anything.
   * Callers that must not block (the event sink) run this off the hot path
   * rather than skipping the confirmation.
   */
  submitMessage(params: SubmitTopicMessageParams): Promise<SubmitTopicMessageResult>;
  /** Releases the underlying SDK client's network connections. */
  close(): void;
}

/**
 * The real adapter: a thin wrapper over `@hashgraph/sdk`'s topic transactions.
 * Not unit-tested directly (same rule as the transfer client: don't test the
 * Hedera SDK) — exercised against live testnet by
 * `packages/payments/scripts/create-topic.ts` and by any live demo run.
 */
export function createHederaSdkTopicClient(config: HederaSdkClientConfig): HederaTopicClient {
  const client: Client = makeSdkClient(config);

  return {
    async createTopic(memo) {
      const response = await new TopicCreateTransaction()
        .setTopicMemo(memo)
        .freezeWith(client)
        .execute(client);
      const receipt = await response.getReceipt(client);
      if (!receipt.topicId) {
        throw new Error('topic create receipt carried no topicId');
      }
      return { topicId: receipt.topicId.toString() };
    },

    async submitMessage({ topicId, message }) {
      const response = await new TopicMessageSubmitTransaction()
        .setTopicId(TopicId.fromString(topicId))
        .setMessage(message)
        .freezeWith(client)
        .execute(client);
      const receipt = await response.getReceipt(client);
      return {
        txId: response.transactionId.toString(),
        // `topicSequenceNumber` is a Long; `toNumber()` is safe here for the
        // same reason it is everywhere else in this repo's Hedera code —
        // a topic would need 2^53 messages to overflow it.
        sequenceNumber: receipt.topicSequenceNumber?.toNumber() ?? 0,
      };
    },

    close() {
      client.close();
    },
  };
}

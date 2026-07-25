/**
 * @assay/payments — Hedera testnet adapter for `PaymentsPort` (see SPEC.md §4).
 *
 * Rail decision: raw HBAR transfer with `requestHash` in the memo, confirmed
 * via mirror node polling. See ../README.md for the spike that led here.
 */

export { createHederaPaymentsPort } from './payments.js';
export type { HederaPaymentsPortConfig } from './payments.js';

export { createHederaSdkTransferClient, makeSdkClient } from './hedera-client.js';
export type {
  HederaNetwork,
  HederaSdkClientConfig,
  HederaTransferClient,
  TransferHbarParams,
} from './hedera-client.js';

export { createHederaSdkTopicClient } from './hcs.js';
export type {
  HederaTopicClient,
  SubmitTopicMessageParams,
  SubmitTopicMessageResult,
} from './hcs.js';

export { parseOperatorKey, assertKeyMatchesAccount, OperatorKeyError } from './operator-key.js';
export type { HederaKeyType } from './operator-key.js';

export { pollMirrorNode, toMirrorNodeTransactionId, MirrorNodeTimeoutError } from './mirror-node.js';
export type { FetchLike, MirrorNodePollAttempt, MirrorNodePollConfig, MirrorNodePollState } from './mirror-node.js';

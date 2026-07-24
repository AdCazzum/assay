/**
 * @assay/graph — `GraphPort` over The Graph's Token API (mainnet, read-only).
 * See README.md for the endpoint mapping and its block-stamping limitations.
 */

export const PACKAGE_ID = '@assay/graph';

export { createGraphAdapter, type CreateGraphAdapterOptions } from './adapter.js';
export {
  GraphApiError,
  GraphMalformedResponseError,
  GraphRateLimitError,
  GraphTokenNotFoundError,
} from './errors.js';
export {
  DEFAULT_NETWORK,
  HEAD_PROXY_TOKEN,
  MINT_RECENCY_BLOCKS,
  STABLECOINS,
  TOP_HOLDERS_COUNT,
  TRANSFER_SCAN_LIMIT,
  ZERO_ADDRESS,
} from './constants.js';

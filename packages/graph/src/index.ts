/**
 * @assay/graph — `GraphPort` over The Graph's decentralized gateway
 * (Uniswap v3 mainnet subgraph, block-pinned). See README.md for the signal
 * mapping and what is left honestly unimplemented.
 */

export const PACKAGE_ID = '@assay/graph';

export { createGraphAdapter, type CreateGraphAdapterOptions } from './adapter.js';
export {
  GraphApiError,
  GraphBlockOutOfRangeError,
  GraphMalformedResponseError,
  GraphRateLimitError,
  GraphTokenNotFoundError,
} from './errors.js';
export {
  normalizeTokenAddress,
  TOP_POOLS_SAMPLE_SIZE,
  UNISWAP_V3_MAINNET_START_BLOCK,
  UNISWAP_V3_MAINNET_SUBGRAPH_ID,
} from './constants.js';

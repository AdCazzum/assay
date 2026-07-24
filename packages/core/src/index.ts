/**
 * @assay/core — the shared rail.
 *
 * Orchestrates the loop over three adapters (ENS registry, Hedera payments,
 * The Graph) and a capability runtime. It knows nothing about rug-score.
 */

export * from './types.js';
export * from './ports.js';
export * from './runtime.js';

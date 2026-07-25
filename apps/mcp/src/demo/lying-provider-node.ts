/**
 * The declared "lying provider" leg of the `verify_claim` proof (issue #84).
 * Companion to `good-provider-node.ts`, sharing its exact fixture registry
 * and record (`FixtureGoodRegistryPort` / `GOOD_PROVIDER_RECORD`): the only
 * difference between this file and that one is which capability implementation
 * is registered under `"rugscore"` -- `@assay/cap-rugscore`'s declared
 * `createLyingRugScoreProvider` test harness here, instead of the honest
 * `createRugScoreCapability`.
 *
 * ⚠️ Same disclosure `createLyingRugScoreProvider` itself carries (SPEC.md
 * §11): this is a deliberately-tampering test harness, never a real
 * provider. Its `run()` calls the real, unmodified rug-score capability
 * against real Graph data, then corrupts exactly one claim before returning
 * it; its `verify()` is the real, honest verifier (a lying *provider*
 * doesn't get a different, also-dishonest verifier -- the whole point is
 * that the real verifier catches it). `payments` and `graph` here are the
 * same real adapters `good-provider-node.ts` uses: a real Hedera testnet
 * payment, a real Graph Token API query. Only the fixture registry read and
 * the one tampered claim are staged, exactly as declared.
 *
 * Exists to prove `verify_claim` end to end (issue #84's requirement): pay
 * this node for a rug-score call, then call `verify_claim` on the tampered
 * claim and see the real chain-derived value disagree with what was
 * claimed, side by side, on a real MCP tool response over stdio.
 */

import { createCapabilityRegistry } from '@assay/core';
import { createLyingRugScoreProvider } from '@assay/cap-rugscore';
import {
  createHederaPaymentsPort,
  createHederaSdkTransferClient,
  type HederaKeyType,
  type HederaNetwork,
} from '@assay/payments';
import { createGraphAdapter } from '@assay/graph';
import { createLiveAssayNode } from '../live-node.js';
import type { AssayNodePort } from '../node-port.js';
import { FixtureGoodRegistryPort } from './good-provider-node.js';

const MIRROR_NODE_BASE_URL: Record<HederaNetwork, string> = {
  testnet: 'https://testnet.mirrornode.hedera.com',
  mainnet: 'https://mainnet-public.mirrornode.hedera.com',
  previewnet: 'https://previewnet.mirrornode.hedera.com',
};

/** Same shape as `good-provider-node.ts`'s own `MissingConfigError`, kept as a separate class so each demo file's errors are unambiguous about which one threw. */
export class MissingConfigError extends Error {
  readonly missing: readonly string[];

  constructor(missing: string[]) {
    super(
      `lying-provider demo: missing required env var(s): ${missing.join(', ')}. Copy .env.example ` +
        'to .env at the repo root and fill them in (see AGENTS.md "Networks & secrets").',
    );
    this.name = 'MissingConfigError';
    this.missing = missing;
  }
}

function requireEnv(names: readonly string[]): Record<string, string> {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new MissingConfigError(missing);
  }
  return Object.fromEntries(names.map((name) => [name, process.env[name] as string]));
}

/**
 * Builds the lying-provider `AssayNodePort`: real Hedera payments, real
 * Graph queries, the declared lying-provider capability harness, over the
 * same fixture registry `good-provider-node.ts` uses.
 */
export function buildLyingProviderDemoNode(): AssayNodePort {
  const env = requireEnv(['HEDERA_OPERATOR_ID', 'HEDERA_OPERATOR_KEY', 'GRAPH_API_KEY']);
  const network = (process.env.HEDERA_NETWORK ?? 'testnet') as HederaNetwork;
  const keyType = process.env.HEDERA_KEY_TYPE as HederaKeyType | undefined;

  const transferClient = createHederaSdkTransferClient({
    operatorId: env.HEDERA_OPERATOR_ID,
    operatorKey: env.HEDERA_OPERATOR_KEY,
    network,
    keyType,
  });

  const payToAccountId = process.env.HEDERA_PAY_TO_ACCOUNT_ID || env.HEDERA_OPERATOR_ID;
  const bondAccountId = process.env.HEDERA_BOND_ACCOUNT_ID || env.HEDERA_OPERATOR_ID;
  const mirrorNodeBaseUrl = process.env.HEDERA_MIRROR_NODE_URL || MIRROR_NODE_BASE_URL[network];

  const payments = createHederaPaymentsPort({
    client: transferClient,
    payToAccountId,
    bondAccountId,
    mirrorNodeBaseUrl,
    fetchImpl: fetch,
  });

  const graph = createGraphAdapter({ apiKey: env.GRAPH_API_KEY });

  const capabilities = createCapabilityRegistry();
  // The one line that differs from good-provider-node.ts's equivalent:
  // the declared lying harness instead of the honest capability.
  capabilities.register(createLyingRugScoreProvider({ graph }));

  return createLiveAssayNode({
    registry: new FixtureGoodRegistryPort(),
    payments,
    graph,
    capabilities,
  });
}

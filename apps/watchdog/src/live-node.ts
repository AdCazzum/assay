/**
 * Builds a real `AssayNode` for the watchdog CLI (`index.ts`): live
 * `@assay/registry` (Sepolia), `@assay/payments` (Hedera testnet),
 * `@assay/graph` (mainnet, read-only), same env-var contract
 * `apps/mcp/src/index.ts`'s `buildLiveNodeFromEnv` uses, so both apps read
 * the same `.env` without surprises.
 *
 * The one thing specific to the watchdog: `capabilityMode` picks which
 * capability answers rug-score requests — the honest `@assay/cap-rugscore`
 * capability, or its declared lying-provider harness
 * (`createLyingRugScoreProvider`, SPEC.md §11). The watchdog's own challenge
 * logic (`watchdog.ts`) never looks at this choice; it exists only so
 * `index.ts` can demo both outcomes (a lie caught, an honest claim upheld)
 * from the same CLI.
 */

import {
  createAssayNode,
  createCapabilityRegistry,
  type AssayNode,
  type AssayNodeConfig,
  type PaymentsPort,
  type RegistryPort,
} from '@assay/core';
import { createEnsRegistry } from '@assay/registry';
import {
  createHederaPaymentsPort,
  createHederaSdkTransferClient,
  type HederaKeyType,
  type HederaNetwork,
} from '@assay/payments';
import { createGraphAdapter } from '@assay/graph';
import { createRugScoreCapability, createLyingRugScoreProvider } from '@assay/cap-rugscore';
import { observeSlash, type SlashRecord } from './slash-observer.js';

export const APP_ID = '@assay/watchdog';

export type CapabilityMode = 'honest' | 'lying';

const MIRROR_NODE_BASE_URL: Record<HederaNetwork, string> = {
  testnet: 'https://testnet.mirrornode.hedera.com',
  mainnet: 'https://mainnet-public.mirrornode.hedera.com',
  previewnet: 'https://previewnet.mirrornode.hedera.com',
};

const HASHSCAN_BASE_URL: Record<HederaNetwork, string> = {
  testnet: 'https://hashscan.io/testnet',
  mainnet: 'https://hashscan.io/mainnet',
  previewnet: 'https://hashscan.io/previewnet',
};

/** Thrown when required env is missing. One readable line naming every absent var, same posture as `apps/mcp`'s `MissingConfigError`. */
export class MissingConfigError extends Error {
  readonly missing: readonly string[];

  constructor(missing: string[]) {
    super(
      `${APP_ID}: missing required env var(s): ${missing.join(', ')}. ` +
        'Copy .env.example to .env at the repo root and fill them in (see AGENTS.md "Networks & secrets").',
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

export type LiveWatchdogNode = {
  node: AssayNode;
  /** The raw registry port `node` was built with. `index.ts` needs this directly (not just through `AssayNode`) to re-bond `providerName` before serving; see `serve-for-challenge.ts`. */
  registry: RegistryPort;
  /** The raw (slash-observed) payments port `node` was built with. Same reason as `registry` above. */
  payments: PaymentsPort;
  network: HederaNetwork;
  hashscanBaseUrl: string;
  /**
   * The ENS name whose manifest+reputation this run acts on. Defaults to
   * `liar.<ENS_PARENT_NAME>` -- a **sacrificial** subname, deliberately
   * separate from the demo's good provider (`rugscore.<ENS_PARENT_NAME>`,
   * see `packages/registry/scripts/reset-demo-state.ts`). Issue #64: every
   * rehearsal of this watchdog serves a real job, challenges it, and (in
   * `lying` mode) triggers a real slash + a real ENS reputation drop -- if
   * that landed on the same name the demo's opening beat depends on, each
   * rehearsal would re-damage the very state the reset script just fixed.
   * Override with `WATCHDOG_PROVIDER_NAME` (e.g. to point the run sheet at
   * yet another name); needs no on-chain creation step first, since
   * `assay.eth`'s wildcard resolver authorizes any subname of it (verified
   * by static call, see issue #64 and `packages/registry/scripts/smoke.ts`'s
   * doc comment).
   */
  providerName: string;
  /** Recovers the txId of the last `payments.slash()` call `node.settle()` made, if any. */
  getLastSlash: () => SlashRecord | undefined;
};

/**
 * Constructs the real `AssayNode` over live adapters, plus everything
 * `index.ts` needs to narrate it (network, HashScan base, the slash
 * observer). Throws `MissingConfigError` up front if required env is
 * absent, before touching any network.
 */
export function buildLiveWatchdogNode(capabilityMode: CapabilityMode): LiveWatchdogNode {
  const env = requireEnv([
    'HEDERA_OPERATOR_ID',
    'HEDERA_OPERATOR_KEY',
    'SEPOLIA_RPC_URL',
    'SEPOLIA_PRIVATE_KEY',
    'ENS_PARENT_NAME',
    'GRAPH_API_KEY',
  ]);

  const network = (process.env.HEDERA_NETWORK ?? 'testnet') as HederaNetwork;
  const keyType = process.env.HEDERA_KEY_TYPE as HederaKeyType | undefined;

  const registry = createEnsRegistry({
    rpcUrl: env.SEPOLIA_RPC_URL,
    privateKey: env.SEPOLIA_PRIVATE_KEY,
    parentName: env.ENS_PARENT_NAME,
  });

  const transferClient = createHederaSdkTransferClient({
    operatorId: env.HEDERA_OPERATOR_ID,
    operatorKey: env.HEDERA_OPERATOR_KEY,
    network,
    keyType,
  });

  // Same disclosed single-operator simplification `apps/mcp/src/index.ts` and
  // `packages/payments/scripts/bond-slash.ts` both make: no second funded
  // testnet account exists, so pay-to, bond-escrow and challenger all default
  // to the operator's own account. Real transactions, real settlement, just
  // one wallet playing every role.
  const payToAccountId = process.env.HEDERA_PAY_TO_ACCOUNT_ID || env.HEDERA_OPERATOR_ID;
  const bondAccountId = process.env.HEDERA_BOND_ACCOUNT_ID || env.HEDERA_OPERATOR_ID;
  const challengerAccountId = process.env.HEDERA_CHALLENGER_ACCOUNT_ID || env.HEDERA_OPERATOR_ID;
  const mirrorNodeBaseUrl = process.env.HEDERA_MIRROR_NODE_URL || MIRROR_NODE_BASE_URL[network];

  const rawPayments = createHederaPaymentsPort({
    client: transferClient,
    payToAccountId,
    bondAccountId,
    mirrorNodeBaseUrl,
    fetchImpl: fetch,
  });
  const { payments, getLastSlash } = observeSlash(rawPayments);

  const graph = createGraphAdapter({ apiKey: env.GRAPH_API_KEY });

  const capabilities = createCapabilityRegistry();
  const honest = createRugScoreCapability({ graph });
  capabilities.register(
    capabilityMode === 'honest'
      ? honest
      : // The declared test harness (SPEC.md §11): runs the same real capability,
        // then tampers exactly one claim. Its `verify()` is the real, honest one.
        createLyingRugScoreProvider({ graph }),
  );

  const config: AssayNodeConfig = { registry, payments, graph, capabilities, challengerAccountId };
  const node = createAssayNode(config);

  // Sacrificial by default (see `LiveWatchdogNode.providerName`'s doc
  // comment above): "liar" both names what this app demos against
  // (the declared lying-provider harness, SPEC.md §11) and keeps it
  // visibly distinct from the good provider a human skimming .env would
  // otherwise conflate the two names for.
  const providerName = process.env.WATCHDOG_PROVIDER_NAME || `liar.${env.ENS_PARENT_NAME}`;

  return {
    node,
    registry,
    payments,
    network,
    hashscanBaseUrl: HASHSCAN_BASE_URL[network],
    providerName,
    getLastSlash,
  };
}

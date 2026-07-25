/**
 * Builds the real, live-network plumbing the demo session (`session.ts`)
 * drives: two `@assay/core` `AssayNode`s over the three live adapters
 * (`@assay/registry` on Sepolia, `@assay/payments` on Hedera testnet,
 * `@assay/graph` on mainnet), plus the raw `RegistryPort`/`PaymentsPort`
 * instances the session needs directly (same reason `apps/mcp`'s
 * `live-node.ts` and `apps/watchdog`'s `live-node.ts` both hold onto theirs:
 * a payment made outside `AssayNode.payAndCall()`'s own gated path still has
 * to go through the identical `pay()`/`confirmPayment()` calls those files
 * already establish as the idiom).
 *
 * **Two nodes, not one.** A `CapabilityRegistry` can only register one
 * `Capability` per id (`packages/core/src/runtime.ts`), and both the good
 * provider (`rugscore.<parent>`) and the sacrificial one (`liar.<parent>`)
 * publish the same `capabilityId` ("rugscore") in their manifest. So a
 * single node cannot serve both an honest run and the declared
 * lying-provider harness (SPEC.md §11) in the same process — exactly the
 * constraint `apps/watchdog`'s `live-node.ts` documents with its own
 * `capabilityMode: 'honest' | 'lying'` (one node, one mode, one run). This
 * app needs *both* live in the same session (discover/pay/serve against the
 * good provider, then challenge against the liar), so it builds two nodes
 * instead: `requesterNode` (honest capability, talks to the good provider)
 * and `challengeNode` (the lying harness, talks to the sacrificial one).
 * They share one `registry`/`payments`/`graph` adapter instance apiece —
 * only the capability registry differs — so this is one Sepolia wallet, one
 * Hedera client, not two.
 *
 * **The reputation-write heartbeat.** `AssayNodeConfig.onSettleProgress`/
 * `onLoopEvent` fire exactly once when the ENS reputation write starts
 * (`'writing-reputation'`) and once when it lands — nothing in between, so a
 * naive wiring of just those two hooks renders a frozen `running` row for
 * however long the write actually takes (8 to 25s, `docs/demo-run-sheet.md`).
 * The per-3-seconds heartbeat during that wait is a *different*, lower-level
 * hook: `@assay/registry`'s own `onReputationWriteAttempt`, bound once at
 * `createEnsRegistry` construction (same precedent `@assay/dashboard`'s
 * README already documents). So this file also wires that hook, through
 * `onReputationHeartbeat` below, straight to the caller — this is the one
 * piece of narration in this app that does not flow through `@assay/core`'s
 * `LoopEvent` stream at all, because core's own contract has no room for it.
 */

import {
  createAssayNode,
  createCapabilityRegistry,
  type AssayNode,
  type LoopEvent,
  type PaymentsPort,
  type RegistryPort,
} from '@assay/core';
import { createEnsRegistry, type ReputationWriteProgress } from '@assay/registry';
import {
  createHederaPaymentsPort,
  createHederaSdkTransferClient,
  type HederaKeyType,
  type HederaNetwork,
} from '@assay/payments';
import { createGraphAdapter } from '@assay/graph';
import { createRugScoreCapability, createLyingRugScoreProvider } from '@assay/cap-rugscore';

export const APP_ID = '@assay/demo';

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

/** Thrown when required env is missing. Same posture as `apps/mcp`/`apps/watchdog`'s own `MissingConfigError`: one readable line naming every absent var, before touching any network. */
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

export type LiveDemoNodes = {
  /** Talks to the good provider (`goodProviderName`) with the honest rug-score capability. Drives keys [1] discover, [2]/[3] pay/serve. */
  requesterNode: AssayNode;
  /** Talks to the sacrificial provider (`liarProviderName`) with the declared lying-provider harness (SPEC.md §11). Drives key [4] challenge. */
  challengeNode: AssayNode;
  /** The raw registry/payments ports both nodes were built with — needed directly for the pay step (see `session.ts`), same as `apps/mcp`'s `force: true` path and `apps/watchdog`'s `serveForChallenge`. */
  registry: RegistryPort;
  payments: PaymentsPort;
  goodProviderName: string;
  liarProviderName: string;
  network: HederaNetwork;
  hashscanBaseUrl: string;
  /** e.g. `https://sepolia.etherscan.io`, for narrating ENS write tx links. */
  etherscanBaseUrl: string;
  /** Closes the underlying Hedera SDK client's gRPC channels. Same "explicit exit, don't hang on open connections" posture `apps/watchdog`/`apps/mcp` already document — call this (or just `process.exit`) once the session is done. */
  close(): void;
};

export type BuildLiveDemoNodesOptions = {
  /** Wired into `requesterNode`'s `AssayNodeConfig.onLoopEvent` at construction (core's own contract: bound once, never per-call). */
  onRequesterEvent?: (event: LoopEvent) => void;
  /** Wired into `challengeNode`'s `AssayNodeConfig.onLoopEvent`. Kept separate from `onRequesterEvent` so the session (`session.ts`) can filter each node's stream differently -- see that file's doc comment on why the challenge node's own discover/pay/serve preamble is not narrated the same way the requester's is. */
  onChallengeEvent?: (event: LoopEvent) => void;
  /** Wired into the shared `registry`'s `onReputationWriteAttempt` (see the module doc comment on why this is a separate hook from the two above). Only the challenge flow in this app ever writes reputation, so this only ever fires during that step. */
  onReputationHeartbeat?: (info: ReputationWriteProgress) => void;
};

/**
 * Constructs both live nodes plus the shared adapters. Throws
 * `MissingConfigError` up front if required env is absent, before
 * constructing anything — the same "fail fast, not mid-demo" posture
 * `apps/mcp`/`apps/watchdog` already established.
 */
export function buildLiveDemoNodes(opts: BuildLiveDemoNodesOptions = {}): LiveDemoNodes {
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
    onReputationWriteAttempt: opts.onReputationHeartbeat,
  });

  const transferClient = createHederaSdkTransferClient({
    operatorId: env.HEDERA_OPERATOR_ID,
    operatorKey: env.HEDERA_OPERATOR_KEY,
    network,
    keyType,
  });

  // Same disclosed single-operator simplification every other live app here
  // makes (apps/mcp, apps/watchdog, packages/registry/scripts/reset-demo-state.ts):
  // no second funded testnet account exists, so pay-to, bond-escrow and
  // challenger all default to the operator's own account.
  const payToAccountId = process.env.HEDERA_PAY_TO_ACCOUNT_ID || env.HEDERA_OPERATOR_ID;
  const bondAccountId = process.env.HEDERA_BOND_ACCOUNT_ID || env.HEDERA_OPERATOR_ID;
  const challengerAccountId = process.env.HEDERA_CHALLENGER_ACCOUNT_ID || env.HEDERA_OPERATOR_ID;
  const mirrorNodeBaseUrl = process.env.HEDERA_MIRROR_NODE_URL || MIRROR_NODE_BASE_URL[network];

  const payments = createHederaPaymentsPort({
    client: transferClient,
    payToAccountId,
    bondAccountId,
    mirrorNodeBaseUrl,
    fetchImpl: fetch,
  });

  const graph = createGraphAdapter({ apiKey: env.GRAPH_API_KEY });

  const honestCapabilities = createCapabilityRegistry();
  honestCapabilities.register(createRugScoreCapability({ graph }));

  const lyingCapabilities = createCapabilityRegistry();
  lyingCapabilities.register(createLyingRugScoreProvider({ graph }));

  const requesterNode = createAssayNode({
    registry,
    payments,
    graph,
    capabilities: honestCapabilities,
    challengerAccountId,
    onLoopEvent: opts.onRequesterEvent,
  });

  const challengeNode = createAssayNode({
    registry,
    payments,
    graph,
    capabilities: lyingCapabilities,
    challengerAccountId,
    onLoopEvent: opts.onChallengeEvent,
  });

  const goodLabel = process.env.DEMO_PROVIDER_LABEL || 'rugscore';
  const liarLabel = process.env.WATCHDOG_PROVIDER_LABEL || 'liar';

  return {
    requesterNode,
    challengeNode,
    registry,
    payments,
    goodProviderName: `${goodLabel}.${env.ENS_PARENT_NAME}`,
    liarProviderName: `${liarLabel}.${env.ENS_PARENT_NAME}`,
    network,
    hashscanBaseUrl: HASHSCAN_BASE_URL[network],
    etherscanBaseUrl: network === 'testnet' ? 'https://sepolia.etherscan.io' : 'https://etherscan.io',
    close: () => transferClient.close(),
  };
}

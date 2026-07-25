/**
 * @assay/mcp — the MCP server exposing `discover` / `pay_and_call` / `challenge`
 * / `rate` (see SPEC.md §4, §7, §10). This is the agent-native surface: in the
 * demo a real Claude agent drives the loop live through these tools.
 *
 * `createAssayMcpServer` takes an `AssayNodePort` so it can be built and
 * tested without live credentials (see `test-support/fake-node.ts`).
 * `main()`, run only when this file is executed directly, constructs the real
 * node (`buildLiveNodeFromEnv`, over live Hedera/Sepolia/Graph adapters) and
 * hands it to the server (issue #46). It fails fast with `MissingConfigError`
 * if required env is absent, rather than booting a server whose tools would
 * only fail later, mid-demo, on first use.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCapabilityRegistry, createEventStamper } from '@assay/core';
import { createEnsRegistry } from '@assay/registry';
import {
  createHederaPaymentsPort,
  createHederaSdkTransferClient,
  type HederaKeyType,
  type HederaNetwork,
} from '@assay/payments';
import { createGraphAdapter } from '@assay/graph';
import { createRugScoreCapability, createLyingRugScoreProvider } from '@assay/cap-rugscore';
import { createAssayMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { createLiveAssayNode } from './live-node.js';
import { createLoopEventSink } from './loop-event-sink.js';
import type { AssayNodePort } from './node-port.js';

export const APP_ID = '@assay/mcp';

/**
 * The lying-provider harness's own capability id (issues #93/#94's
 * capability-wiring fix, see `buildLiveNodeFromEnv` below). Exported for
 * this app's own tests. `packages/registry/scripts/reset-demo-state.ts`
 * cannot import this (a package script importing from an app would be a
 * backwards dependency this repo's layering never allows elsewhere), so it
 * repeats this exact string as its own `LYING_CAPABILITY_ID` constant with a
 * comment pointing back here -- keep the two in sync by hand if this ever
 * changes.
 */
export const LYING_CAPABILITY_ID = 'rugscore.v2';

export { createAssayMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';
export type { AssayNodePort, DiscoverResult } from './node-port.js';
export { NotWiredAssayNode, NodeNotWiredError } from './not-wired-node.js';
export { createLiveAssayNode, RateNotApplicableError } from './live-node.js';
export type { LiveAssayNodeConfig } from './live-node.js';

// A `.env` at the repo root, same convention every other package's live
// script uses (see e.g. packages/payments/scripts/spike.ts). Never committed
// (AGENTS.md); this is a no-op if the file doesn't exist, which just means
// `buildLiveNodeFromEnv` below fails on the first missing var instead.
const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../..');
loadEnv({ path: path.join(repoRoot, '.env') });

const MIRROR_NODE_BASE_URL: Record<HederaNetwork, string> = {
  testnet: 'https://testnet.mirrornode.hedera.com',
  mainnet: 'https://mainnet-public.mirrornode.hedera.com',
  previewnet: 'https://previewnet.mirrornode.hedera.com',
};

/**
 * Thrown by `buildLiveNodeFromEnv` when required config is missing. One
 * readable line naming every absent var, not a half-booted server that fails
 * confusingly on the first tool call (per #46: "fail with a clear message
 * when something is missing rather than booting a half-broken server").
 */
export class MissingConfigError extends Error {
  readonly missing: readonly string[];

  constructor(missing: string[]) {
    super(
      `${APP_ID}: missing required env var(s): ${missing.join(', ')}. ` +
        'Copy .env.example to .env at the repo root and fill them in ' +
        '(see AGENTS.md "Networks & secrets").',
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
 * Constructs the real `AssayNodePort` over the three live adapters (issue
 * #46): `@assay/registry` on Sepolia, `@assay/payments` on Hedera testnet,
 * `@assay/graph` on mainnet, plus the one real capability, rug-score. Reads
 * every credential from `process.env` (populated above from `.env`); throws
 * `MissingConfigError` up front if any required var is absent, before
 * constructing anything.
 */
export function buildLiveNodeFromEnv(): AssayNodePort {
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

  // The NDJSON event sink (issue #93). Unset (the default): no sink is
  // opened, `onLoopEvent`/`onReputationWriteAttempt`/`onConfirmAttempt` below
  // are all left undefined, and every emit call in `@assay/core`/
  // `@assay/registry`/`@assay/payments` is already a documented no-op when
  // its hook is absent -- so this is inert exactly like the hooks already
  // are, no behaviour change. Set: one `createEventStamper()` is shared
  // between the node's own real LoopEvents and the sink's own synthesized
  // heartbeat lines, so `seq` stays one strictly-increasing sequence across
  // both (`loop-event-sink.ts`'s own doc comment on why that cast is safe).
  //
  // **Never touches stdout.** `StdioServerTransport` below owns stdout as the
  // MCP JSON-RPC channel; this sink writes only to the file at
  // `ASSAY_LOOP_EVENTS_SINK`, and `createLoopEventSink` never throws even if
  // that path is unwritable (see its own tests) -- a broken sink narrates
  // nothing further, it does not break a tool call.
  const sinkPath = process.env.ASSAY_LOOP_EVENTS_SINK;
  const stamp = createEventStamper();
  const sink = sinkPath ? createLoopEventSink(sinkPath, stamp) : undefined;

  const registry = createEnsRegistry({
    rpcUrl: env.SEPOLIA_RPC_URL,
    privateKey: env.SEPOLIA_PRIVATE_KEY,
    parentName: env.ENS_PARENT_NAME,
    // The ENS reputation write's own ~3s submitted/pending/confirmed
    // heartbeat (issue #93's companion wire, see loop-event-sink.ts): the
    // 8-25s write is the single longest deterministic silence in the demo,
    // and core's own LoopEvent stream only reports its start and its end.
    onReputationWriteAttempt: sink
      ? (info) => sink.sinkHeartbeat({ kind: 'heartbeat', of: 'reputation-write', ...info })
      : undefined,
  });

  const transferClient = createHederaSdkTransferClient({
    operatorId: env.HEDERA_OPERATOR_ID,
    operatorKey: env.HEDERA_OPERATOR_KEY,
    network,
    keyType,
  });

  // No second funded testnet account exists yet as of this writing
  // (packages/payments/README.md: pay/bond/slash were all proven as
  // self-transfers to the operator). Pay-to and bond-escrow default to the
  // operator's own account for the same reason scripts/spike.ts and
  // scripts/bond-slash.ts do; override either once a real counterparty
  // account is provisioned.
  const payToAccountId = process.env.HEDERA_PAY_TO_ACCOUNT_ID || env.HEDERA_OPERATOR_ID;
  const bondAccountId = process.env.HEDERA_BOND_ACCOUNT_ID || env.HEDERA_OPERATOR_ID;
  // Same disclosed simplification as `payToAccountId`/`bondAccountId` above:
  // the watchdog challenging a claim is, in this single-operator build, the
  // same funded testnet account as everyone else (see
  // `packages/core`'s `AssayNodeConfig.challengerAccountId` doc comment and
  // `packages/payments/scripts/bond-slash.ts`).
  const challengerAccountId = process.env.HEDERA_CHALLENGER_ACCOUNT_ID || env.HEDERA_OPERATOR_ID;
  const mirrorNodeBaseUrl = process.env.HEDERA_MIRROR_NODE_URL || MIRROR_NODE_BASE_URL[network];

  const payments = createHederaPaymentsPort({
    client: transferClient,
    payToAccountId,
    bondAccountId,
    mirrorNodeBaseUrl,
    fetchImpl: fetch,
    // The mirror-node payment-confirm heartbeat (graft from Proposal 1, see
    // loop-event-sink.ts's module doc comment): lower priority than the
    // reputation-write one above since confirm is measured at ~4s not
    // 8-25s, but it shares the exact same sink mechanism, so it costs one
    // more wire, not a second mechanism.
    onConfirmAttempt: sink
      ? (info) => sink.sinkHeartbeat({ kind: 'heartbeat', of: 'payment-confirm', ...info })
      : undefined,
  });

  const graph = createGraphAdapter({ apiKey: env.GRAPH_API_KEY });

  const capabilities = createCapabilityRegistry();
  capabilities.register(createRugScoreCapability({ graph }));
  // The declared lying-provider harness (SPEC.md §11), registered under its
  // own distinct capability id so it can coexist with the honest one in this
  // single `CapabilityRegistry` (`createCapabilityRegistry.register` keys
  // purely on `capability.id`; two entries under `'rugscore'` would throw
  // `DuplicateCapabilityError`). This is what makes `vantage.<parent>` dispatch
  // to a capability that actually lies, rather than colliding with the
  // honest one and silently running honest code under a dishonest name --
  // see `packages/registry/scripts/reset-demo-state.ts`, which republishes
  // `vantage.<parent>`'s manifest with `capabilityId: LYING_CAPABILITY_ID` to
  // match. Verified by reading the code (not assumed): before this change,
  // `vantage.<parent>`'s manifest carried whatever `capabilityId` it already
  // had on-chain (`rugscore`, spread from `before.manifest`), so calling
  // `pay_and_call` on it ran the honest capability -- there was no live lie
  // to catch, only a rehearsed transcript of one.
  capabilities.register(createLyingRugScoreProvider({ graph }, { id: LYING_CAPABILITY_ID }));

  // The two names already live on Sepolia as of this writing (SPEC.md §7,
  // docs/demo-run-sheet.md): the good provider and the sacrificial "vantage"
  // one the watchdog targets. Overridable via `ASSAY_CANDIDATE_PROVIDER_NAMES`
  // (comma-separated) so a demo variant, or a freshly `register_provider`-ed
  // name, can be added to what `list_providers` resolves without a code
  // change.
  const candidateProviderNames = process.env.ASSAY_CANDIDATE_PROVIDER_NAMES
    ? process.env.ASSAY_CANDIDATE_PROVIDER_NAMES.split(',').map((name) => name.trim()).filter(Boolean)
    : [`rugscore.${env.ENS_PARENT_NAME}`, `vantage.${env.ENS_PARENT_NAME}`];

  return createLiveAssayNode({
    registry,
    payments,
    graph,
    capabilities,
    challengerAccountId,
    ensParentName: env.ENS_PARENT_NAME,
    candidateProviderNames,
    eventStamper: stamp,
    onLoopEvent: sink ? (event) => sink.sinkLoopEvent(event) : undefined,
  });
}

async function main(): Promise<void> {
  const node = buildLiveNodeFromEnv();
  const server = createAssayMcpServer(node);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP clients speak JSON-RPC over stdout; stderr is safe for our own logs.
  console.error(`${SERVER_NAME} v${SERVER_VERSION} listening over stdio.`);
}

const isMain = process.argv[1] ? import.meta.url === `file://${process.argv[1]}` : false;
if (isMain) {
  main().catch((err) => {
    console.error('assay MCP server failed to start:', err);
    process.exit(1);
  });
}

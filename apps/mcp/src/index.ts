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
import { createCapabilityRegistry } from '@assay/core';
import { createEnsRegistry } from '@assay/registry';
import {
  createHederaPaymentsPort,
  createHederaSdkTransferClient,
  type HederaKeyType,
  type HederaNetwork,
} from '@assay/payments';
import { createGraphAdapter } from '@assay/graph';
import { createRugScoreCapability } from '@assay/cap-rugscore';
import { createAssayMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { createLiveAssayNode } from './live-node.js';
import type { AssayNodePort } from './node-port.js';

export const APP_ID = '@assay/mcp';

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

  // No second funded testnet account exists yet as of this writing
  // (packages/payments/README.md: pay/bond/slash were all proven as
  // self-transfers to the operator). Pay-to and bond-escrow default to the
  // operator's own account for the same reason scripts/spike.ts and
  // scripts/bond-slash.ts do; override either once a real counterparty
  // account is provisioned.
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
  capabilities.register(createRugScoreCapability({ graph }));

  return createLiveAssayNode({ registry, payments, graph, capabilities });
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

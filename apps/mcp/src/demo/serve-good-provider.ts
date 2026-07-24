/**
 * Boots the Assay MCP server (the same `discover` / `pay_and_call` /
 * `challenge` / `rate` tools as `../index.ts`) wired to
 * `buildGoodProviderDemoNode` (issue #24): real Hedera payments, real Graph
 * queries, real rug-score capability, over a declared-fixture, well
 * -collateralized registry read. See `good-provider-node.ts`'s module doc
 * comment for exactly what is real and what is staged, and why.
 *
 * Reads `.env` at the repo root the same way `../index.ts` does. Fails fast
 * with `MissingConfigError` if `HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY` /
 * `GRAPH_API_KEY` are absent (no `SEPOLIA_*` needed for this leg).
 *
 * Run directly with tsx: `pnpm --filter @assay/mcp exec tsx
 * src/demo/serve-good-provider.ts`.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAssayMcpServer, SERVER_NAME, SERVER_VERSION } from '../server.js';
import { buildGoodProviderDemoNode } from './good-provider-node.js';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../..');
loadEnv({ path: path.join(repoRoot, '.env') });

async function main(): Promise<void> {
  const node = buildGoodProviderDemoNode();
  const server = createAssayMcpServer(node);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP clients speak JSON-RPC over stdout; stderr is safe for our own logs.
  console.error(
    `${SERVER_NAME} v${SERVER_VERSION} listening over stdio (DECLARED FIXTURE registry, REAL ` +
      'Hedera/Graph/capability -- good-provider pay demo, see apps/mcp/agent/README.md).',
  );
}

main().catch((err) => {
  console.error('assay MCP good-provider demo server failed to start:', err);
  process.exit(1);
});

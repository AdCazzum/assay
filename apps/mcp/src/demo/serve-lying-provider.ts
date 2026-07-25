/**
 * Boots the Assay MCP server wired to `buildLyingProviderDemoNode` (issue
 * #84): real Hedera payments, real Graph queries, the declared
 * lying-provider capability harness, over the same fixture registry
 * `serve-good-provider.ts` uses. See `lying-provider-node.ts`'s module doc
 * comment for exactly what is real and what is staged, and why.
 *
 * Run directly with tsx: `pnpm --filter @assay/mcp exec tsx
 * src/demo/serve-lying-provider.ts`.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAssayMcpServer, SERVER_NAME, SERVER_VERSION } from '../server.js';
import { buildLyingProviderDemoNode } from './lying-provider-node.js';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../..');
loadEnv({ path: path.join(repoRoot, '.env') });

async function main(): Promise<void> {
  const node = buildLyingProviderDemoNode();
  const server = createAssayMcpServer(node);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP clients speak JSON-RPC over stdout; stderr is safe for our own logs.
  console.error(
    `${SERVER_NAME} v${SERVER_VERSION} listening over stdio (DECLARED FIXTURE registry AND ` +
      'LYING capability harness, REAL Hedera/Graph -- verify_claim tampered-claim proof, issue #84).',
  );
}

main().catch((err) => {
  console.error('assay MCP lying-provider demo server failed to start:', err);
  process.exit(1);
});

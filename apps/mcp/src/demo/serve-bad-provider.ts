/**
 * Boots the Assay MCP server (the same `discover` / `pay_and_call` /
 * `challenge` / `rate` tools as `../index.ts`) wired to
 * `createBadProviderDemoNode` instead of a live node (issue #24).
 *
 * This is the declared-fixture half of the pay/decline demo: run this
 * process, point a Claude client at it over stdio with the exact same
 * prompt used against the real server (`../index.ts`, see
 * `apps/mcp/agent/README.md`), and the agent should decline to pay by its
 * own reasoning. Nothing here touches Sepolia, Hedera, or The Graph — see
 * `bad-provider-node.ts`'s module doc comment for why that leg is staged
 * rather than a second live ENS registration.
 *
 * Run directly with tsx (no build step, matching every other app in this
 * repo): `pnpm --filter @assay/mcp exec tsx src/demo/serve-bad-provider.ts`.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAssayMcpServer, SERVER_NAME, SERVER_VERSION } from '../server.js';
import { createBadProviderDemoNode } from './bad-provider-node.js';

async function main(): Promise<void> {
  const node = createBadProviderDemoNode();
  const server = createAssayMcpServer(node);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP clients speak JSON-RPC over stdout; stderr is safe for our own logs.
  console.error(
    `${SERVER_NAME} v${SERVER_VERSION} listening over stdio (DECLARED FIXTURE: bad-provider decline demo, ` +
      'not a live node -- see apps/mcp/agent/README.md).',
  );
}

main().catch((err) => {
  console.error('assay MCP bad-provider demo server failed to start:', err);
  process.exit(1);
});

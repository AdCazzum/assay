/**
 * @assay/mcp — the MCP server exposing `discover` / `pay_and_call` / `challenge`
 * / `rate` (see SPEC.md §4, §7, §10). This is the agent-native surface: in the
 * demo a real Claude agent drives the loop live through these tools.
 *
 * `createAssayMcpServer` takes an `AssayNodePort` so it can be built and
 * tested without live credentials (see `test-support/fake-node.ts`).
 * `main()`, run only when this file is executed directly, is the one place
 * that decides which node implementation is real; today that is
 * `NotWiredAssayNode` because `@assay/core`'s `createAssayNode` had not
 * landed yet when this server was built (see `not-wired-node.ts`).
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAssayMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { NotWiredAssayNode } from './not-wired-node.js';

export const APP_ID = '@assay/mcp';

export { createAssayMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';
export type { AssayNodePort } from './node-port.js';
export { NotWiredAssayNode, NodeNotWiredError } from './not-wired-node.js';

async function main(): Promise<void> {
  const server = createAssayMcpServer(new NotWiredAssayNode());
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

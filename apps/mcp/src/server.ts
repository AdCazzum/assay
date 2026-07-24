import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AssayNodePort } from './node-port.js';
import { registerDiscoverTool } from './tools/discover.js';
import { registerPayAndCallTool } from './tools/pay-and-call.js';
import { registerChallengeTool } from './tools/challenge.js';
import { registerRateTool } from './tools/rate.js';

export const SERVER_NAME = 'assay';
export const SERVER_VERSION = '0.0.0';

/**
 * Builds the Assay MCP server: `discover`, `pay_and_call`, `challenge`,
 * `rate`, wired against whatever `AssayNodePort` it is given (SPEC.md §4,
 * §7). Takes the node as a parameter rather than constructing one so it can
 * be built and tested against a fake node without live credentials, and so
 * `index.ts`'s `main()` is the only place that decides which node
 * implementation is real.
 */
export function createAssayMcpServer(node: AssayNodePort): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerDiscoverTool(server, node);
  registerPayAndCallTool(server, node);
  registerChallengeTool(server, node);
  registerRateTool(server, node);

  return server;
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AssayNodePort } from './node-port.js';
import { registerDiscoverTool } from './tools/discover.js';
import { registerPayAndCallTool } from './tools/pay-and-call.js';
import { registerChallengeTool } from './tools/challenge.js';
import { registerRateTool } from './tools/rate.js';
import { registerVerifyClaimTool } from './tools/verify-claim.js';
import { registerRegisterProviderTool } from './tools/register-provider.js';
import { registerListProvidersTool } from './tools/list-providers.js';
import { registerGetJobTool } from './tools/get-job.js';
import { registerListJobsTool } from './tools/list-jobs.js';

export const SERVER_NAME = 'assay';
export const SERVER_VERSION = '0.0.0';

/**
 * Builds the Assay MCP server: `discover`, `pay_and_call`, `challenge`,
 * `rate`, `verify_claim`, `register_provider`, `list_providers`, `get_job`,
 * `list_jobs`, wired against whatever `AssayNodePort` it is given (SPEC.md
 * §4, §7; the last five, issue #84). Takes the node as a parameter rather
 * than constructing one so it can be built and tested against a fake node
 * without live credentials, and so `index.ts`'s `main()` is the only place
 * that decides which node implementation is real.
 */
export function createAssayMcpServer(node: AssayNodePort): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerDiscoverTool(server, node);
  registerPayAndCallTool(server, node);
  registerChallengeTool(server, node);
  registerRateTool(server, node);
  registerVerifyClaimTool(server, node);
  registerRegisterProviderTool(server, node);
  registerListProvidersTool(server, node);
  registerGetJobTool(server, node);
  registerListJobsTool(server, node);

  return server;
}

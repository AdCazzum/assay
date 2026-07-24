import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AssayNodePort } from '../node-port.js';
import { toToolError } from '../tool-error.js';

const inputSchema = {
  capabilityId: z
    .string()
    .min(1)
    .describe('The capability to call, matching a prior discover() result, e.g. "rugscore".'),
  request: z
    .string()
    .min(1)
    .describe(
      'The capability-specific request payload. For "rugscore" this is the ERC-20 token ' +
        'contract address (0x...) on Ethereum mainnet to score.',
    ),
};

/**
 * Registers `pay_and_call`: pays the provider's price on Hedera testnet,
 * confirms it via the mirror node, and has the provider run the capability
 * (SPEC.md §7 steps 3-4). This is the tool with real value moving on-chain,
 * so its description says so plainly and tells the agent to have made the
 * pay/no-pay call itself first via `discover`.
 */
export function registerPayAndCallTool(server: McpServer, node: AssayNodePort): void {
  server.registerTool(
    'pay_and_call',
    {
      title: 'Pay a provider and call its capability',
      description:
        'Pay the provider\'s posted price for a capability on Hedera testnet, wait for the ' +
        'payment to confirm on the mirror node, then have the provider run the capability and ' +
        'return its result. This SPENDS real testnet HBAR: only call it after discover has shown ' +
        'you a manifest and reputation you find acceptable, never speculatively. The result comes ' +
        'back with factual, block-stamped claims and is optimistically accepted: it counts as ' +
        'valid unless you (or anyone) later calls challenge on one of its claims and the verifier ' +
        'disagrees.',
      inputSchema,
      annotations: {
        title: 'Pay a provider and call its capability',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ capabilityId, request }) => {
      try {
        const job = await node.payAndCall(capabilityId, request);
        const claimsSummary = job.claims
          .map((c) => `${c.k}=${JSON.stringify(c.v)} (at block ${c.atBlock})`)
          .join(', ');
        const summary =
          `Paid and served job "${job.jobId}" from provider "${job.provider}" ` +
          `(payment tx ${job.paymentTx}). Result: ${JSON.stringify(job.result)}. ` +
          `Claims: ${claimsSummary || '(none)'}. Status: ${job.status}. ` +
          'This is optimistically valid; call challenge if a claim looks wrong, or rate to close it out.';
        return {
          content: [{ type: 'text', text: summary }],
          structuredContent: job as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}

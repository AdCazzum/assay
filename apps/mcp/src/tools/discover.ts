import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AssayNodePort } from '../node-port.js';
import { toToolError } from '../tool-error.js';

const inputSchema = {
  capabilityId: z
    .string()
    .min(1)
    .describe(
      'The capability to look up, e.g. "rugscore". This is the ENS subname ' +
        'under the Assay parent name (assay.eth on Sepolia), not a free-text query.',
    ),
};

/**
 * Registers `discover`: the read-only lookup a requester agent runs before
 * ever spending anything (SPEC.md §7 step 2). The description below is the
 * one piece of prose that most determines whether the agent's decision to pay
 * later is genuine reasoning or a coin flip, so it spells out exactly what is
 * and is not decided here.
 */
export function registerDiscoverTool(server: McpServer, node: AssayNodePort): void {
  server.registerTool(
    'discover',
    {
      title: 'Discover an Assay provider',
      description:
        'Resolve a capability (e.g. "rugscore") to its provider over ENS and return two things: ' +
        'the manifest (what it does, its price in HBAR per call, its endpoint, its posted bond) and ' +
        'its on-chain reputation (score, number of jobs completed, number of times it has been ' +
        'slashed for a proven-false claim, and its current bond in HBAR). This call is read-only: ' +
        'it never pays and never invokes the provider. Deciding whether the price is justified by ' +
        'the reputation is YOUR call, not this tool\'s: weigh the score against the price, treat a ' +
        'low job count as low confidence even with a good score, and treat any past slash as a real ' +
        'red flag, not noise. If the reputation does not justify the price, do not call pay_and_call.',
      inputSchema,
      annotations: {
        title: 'Discover an Assay provider',
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ capabilityId }) => {
      try {
        const record = await node.discover(capabilityId);
        const { manifest, reputation } = record;
        const summary =
          `Provider "${record.name}" for capability "${manifest.capabilityId}": ` +
          `${manifest.description}. Price: ${manifest.priceHbar} HBAR/call. ` +
          `Reputation: score ${reputation.score}, ${reputation.jobs} jobs completed, ` +
          `${reputation.slashes} slashes, bond ${reputation.bondHbar} HBAR. ` +
          'Weigh this before calling pay_and_call; nothing here pays automatically.';
        return {
          content: [{ type: 'text', text: summary }],
          structuredContent: record as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}

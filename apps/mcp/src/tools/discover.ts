import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AssayNodePort } from '../node-port.js';
import { toToolError } from '../tool-error.js';

const inputSchema = {
  capabilityId: z
    .string()
    .min(1)
    .describe(
      'The provider to look up, as its full ENS name under the Assay parent name ' +
        '(e.g. "rugscore.assay.eth" on Sepolia), not a bare label and not a free-text query.',
    ),
};

/**
 * Registers `discover`: the read-only lookup a requester agent runs before
 * ever spending anything (SPEC.md §7 step 2). The description below is the
 * one piece of prose that most determines whether the agent's decision to pay
 * later is genuine reasoning or a coin flip, so it spells out exactly what is
 * and is not decided here.
 *
 * The result carries both the raw manifest/reputation *and* a structured
 * assessment (issue #21's `assessProvider`, wired in for #46): each signal
 * names its own severity (`info` / `caution` / `concern`) and is rendered
 * generically here, never keyed off a hardcoded signal name, so this stays
 * correct however `assessProvider`'s signal set evolves.
 */
export function registerDiscoverTool(server: McpServer, node: AssayNodePort): void {
  server.registerTool(
    'discover',
    {
      title: 'Discover an Assay provider',
      description:
        'Resolve a provider (by its full ENS name, e.g. "rugscore.assay.eth") and return: its ' +
        'manifest (what it does, its price in HBAR per call, its endpoint, its posted bond), its ' +
        'raw on-chain reputation (score, jobs completed, slashes, bond), and a structured ' +
        'assessment of that reputation, i.e. a list of signals, each with a severity ' +
        '(info/caution/concern) and a human-readable reason. This call is read-only: it never ' +
        'pays and never invokes the provider. Deciding whether the price is justified is YOUR ' +
        'call, not this tool\'s: read every signal, weigh a "concern" more heavily than a ' +
        '"caution", and do not treat an unproven (0-job) provider as if it had a good record, it ' +
        'is unscored, not vetted. If the reputation does not justify the price, do not call ' +
        'pay_and_call.',
      inputSchema,
      annotations: {
        title: 'Discover an Assay provider',
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ capabilityId }) => {
      try {
        const { provider, assessment } = await node.discover(capabilityId);
        const { manifest, reputation } = provider;
        const signalLines = assessment.signals
          .map((signal) => `  [${signal.severity.toUpperCase()}] ${signal.key}: ${signal.detail}`)
          .join('\n');
        const summary =
          `Provider "${provider.name}" for capability "${manifest.capabilityId}": ` +
          `${manifest.description}. Price: ${manifest.priceHbar} HBAR/call. ` +
          `Reputation: score ${reputation.score}, ${reputation.jobs} jobs completed, ` +
          `${reputation.slashes} slashes, bond ${reputation.bondHbar} HBAR.\n\n` +
          `Assessment (reason over these, don't just skim the score):\n${signalLines}\n\n` +
          'This is read-only; nothing here pays automatically. Decide for yourself whether the ' +
          'price is justified before calling pay_and_call.';
        return {
          content: [{ type: 'text', text: summary }],
          structuredContent: { provider, assessment } as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}

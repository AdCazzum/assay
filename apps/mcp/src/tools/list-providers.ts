import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AssayNodePort } from '../node-port.js';
import { toToolError } from '../tool-error.js';

/**
 * Registers `list_providers`: discovery over more than one hardcoded name
 * (issue #84). ENS cannot be enumerated, so this resolves a *configured*
 * candidate set (the names this node was started with, e.g. the two
 * providers already live on Sepolia, SPEC.md §7) rather than searching one;
 * a candidate that fails to resolve, or has no manifest, comes back as a
 * clearly-labelled miss, never an error that kills the whole call.
 *
 * Takes no input: there is nothing for a caller to parametrize, the
 * candidate set lives in this node's own configuration.
 */
export function registerListProvidersTool(server: McpServer, node: AssayNodePort): void {
  server.registerTool(
    'list_providers',
    {
      title: 'List every known Assay provider',
      description:
        'Resolve every candidate provider this node knows about (a configured set of ENS names, ' +
        'NOT a live search of all of ENS -- that is not possible, ENS cannot be enumerated) and ' +
        'return each one\'s manifest, reputation, and structured assessment, exactly like `discover` ' +
        'would for each name individually. A name that fails to resolve, or has no manifest yet, ' +
        'comes back as a clearly-labelled miss with a reason, not an error -- one bad candidate never ' +
        'stops the rest from resolving. Read-only: this never pays and never invokes anyone. Use this ' +
        'to compare multiple providers\' reputations before choosing which one, if any, to call ' +
        '`pay_and_call` against; if you already know the exact name you want, `discover` alone is ' +
        'cheaper.',
      annotations: {
        title: 'List every known Assay provider',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const providers = await node.listProviders();
        if (providers.length === 0) {
          const text =
            'No candidate providers are configured on this node. This does not mean no providers ' +
            'exist on Assay, only that this node was not given any names to check: ENS cannot be ' +
            'enumerated, so this call is limited to whatever candidate set it was configured with. ' +
            'Use `discover` with a specific name if you already know one.';
          return { content: [{ type: 'text', text }], structuredContent: { providers } };
        }

        const lines = providers
          .map((item) => {
            if (item.outcome === 'miss') {
              return `  [MISS] ${item.name}: ${item.reason}`;
            }
            const { manifest, reputation } = item.provider;
            return (
              `  [OK] ${item.name} -- capability "${manifest.capabilityId}": ${manifest.priceHbar} HBAR/call. ` +
              `Reputation: score ${reputation.score}, ${reputation.jobs} jobs, ${reputation.slashes} slashes, ` +
              `bond ${reputation.bondHbar} HBAR.`
            );
          })
          .join('\n');
        const hits = providers.filter((item) => item.outcome === 'ok').length;
        const summary =
          `Resolved ${providers.length} candidate provider(s), ${hits} live:\n${lines}\n\n` +
          'Each "OK" entry\'s structuredContent also carries its full structured assessment (signals, ' +
          'severities, the same material `discover` returns) -- read it before choosing between ' +
          'providers, do not compare on the raw score alone. A "MISS" is not an error in this call.';
        return {
          content: [{ type: 'text', text: summary }],
          structuredContent: { providers } as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AssayNodePort } from '../node-port.js';
import { toToolError } from '../tool-error.js';

const inputSchema = {
  jobId: z.string().min(1).describe('The jobId returned by a prior pay_and_call.'),
  claimKey: z
    .string()
    .min(1)
    .describe(
      'The `k` of the specific claim to dispute, e.g. "liquidityUsd". Must be one of the ' +
        'keys in that job\'s claims.',
    ),
};

/**
 * Registers `challenge`: disputes one claim of a served job (SPEC.md §7 step
 * 6, the demo's headline moment). The verifier re-derives the claim from The
 * Graph at the exact block it was stamped at, so a challenge can only ever
 * turn on the facts, never on the caller's opinion.
 */
export function registerChallengeTool(server: McpServer, node: AssayNodePort): void {
  server.registerTool(
    'challenge',
    {
      title: 'Challenge a claim in a served job',
      description:
        'Dispute one factual claim from a job\'s result. The verifier re-derives that exact claim ' +
        'from The Graph at the same block it was originally stamped at and compares it: if the ' +
        'provider lied, its bond is slashed on Hedera (a real transaction) and its ENS reputation ' +
        'drops; if the claim holds, the challenge fails and the provider\'s reputation rises ' +
        'instead. Call this when you suspect a specific claim is objectively false, not when you ' +
        'are merely unsatisfied with the service, that is what `rate` is for.',
      inputSchema,
      annotations: {
        title: 'Challenge a claim in a served job',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ jobId, claimKey }) => {
      try {
        const job = await node.challenge(jobId, claimKey);
        const verdict = job.verdict;
        const verdictSummary = verdict
          ? verdict.valid
            ? 'valid: the claim held up, the challenge failed.'
            : `invalid: claim "${verdict.badClaim ?? claimKey}" was false. ${verdict.reason ?? ''}`.trim()
          : '(no verdict returned)';
        const summary =
          `Challenged claim "${claimKey}" on job "${jobId}". Verdict: ${verdictSummary} ` +
          `Job status is now "${job.status}".`;
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

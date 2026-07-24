import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AssayNodePort } from '../node-port.js';
import { toToolError } from '../tool-error.js';

const inputSchema = {
  jobId: z.string().min(1).describe('The jobId returned by a prior pay_and_call.'),
  satisfied: z
    .boolean()
    .describe(
      'Whether the job was satisfactory. true closes it out as a successfully completed job ' +
        '(the provider\'s jobs count rises, and its score with it); false records it as ' +
        'unsatisfactory without slashing anything.',
    ),
  comment: z.string().optional().describe('Optional free-text note kept with the job record.'),
};

/**
 * Registers `rate`: closes out a served job the caller is choosing NOT to
 * challenge. This is the non-adversarial complement to `challenge`: it never
 * touches the verifier and never slashes the provider's bond, it only
 * accounts for the job as done. Reputation stays evidence-based (SPEC.md §3):
 * this records completion, not a subjective star rating, so use `challenge`
 * instead whenever a specific claim looks objectively false.
 *
 * Wired against the real node (issue #46), `rate` still fails with a clear,
 * named error against `@assay/registry`'s live ENS adapter: `updateReputation`
 * (the write this needs) is itself an explicit stub until #16 lands. The job
 * itself does close out for real: `rate` moves it `served -> settled` (with
 * no `verdict`, distinguishing "nobody challenged it" from a challenge that
 * failed) through the `JobStore` transition #26/#27 added — see
 * `live-node.ts`'s `rate` doc comment.
 */
export function registerRateTool(server: McpServer, node: AssayNodePort): void {
  server.registerTool(
    'rate',
    {
      title: 'Close out a job without challenging it',
      description:
        'Close out an already-served job you are not disputing: mark it satisfied to count it as ' +
        'a successfully completed job toward the provider\'s reputation, or unsatisfied to flag it ' +
        'without slashing anything. This never invokes the verifier and never touches the ' +
        'provider\'s bond. If you think a specific claim in the result is objectively false, use ' +
        '`challenge` instead, that is the only path that can slash a lying provider.',
      inputSchema,
      annotations: {
        title: 'Close out a job without challenging it',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ jobId, satisfied, comment }) => {
      try {
        const job = await node.rate(jobId, satisfied, comment);
        const summary =
          `Rated job "${jobId}" as ${satisfied ? 'satisfied' : 'unsatisfied'}. ` +
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

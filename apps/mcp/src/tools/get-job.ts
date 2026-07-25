import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Job } from '@assay/core';
import type { AssayNodePort } from '../node-port.js';
import { toToolError } from '../tool-error.js';

const inputSchema = {
  jobId: z.string().min(1).describe('The jobId returned by a prior pay_and_call.'),
};

/** One line per claim, generic over whatever keys the capability that served this job actually claimed -- never a hardcoded signal name. */
function formatClaims(job: Job): string {
  if (job.claims.length === 0) return '(none)';
  return job.claims.map((c) => `${c.k}=${JSON.stringify(c.v)} (at block ${c.atBlock})`).join(', ');
}

function formatVerdict(job: Job): string {
  if (!job.verdict) return '(no verdict yet -- nobody has challenged or verified a claim on this job)';
  if (job.verdict.valid) return 'valid (the challenged claim held up)';
  return `invalid -- claim "${job.verdict.badClaim ?? '(unknown)'}" was false${
    job.verdict.reason ? `: ${job.verdict.reason}` : ''
  }`;
}

/**
 * Registers `get_job`: read access to what an agent actually bought (issue
 * #84). Before this, a `pay_and_call` result was the only place a caller
 * ever saw a job's claims or status -- there was no way to look one back up
 * later, e.g. across separate tool calls or after a `challenge`/`rate`
 * changed its status. Thin, read-only pass-through to the node's job store:
 * no network call, no side effect.
 */
export function registerGetJobTool(server: McpServer, node: AssayNodePort): void {
  server.registerTool(
    'get_job',
    {
      title: 'Look up one job by id',
      description:
        'Look up a single job by its jobId: which provider served it, its status ' +
        '(served/challenged/slashed/settled), its block-stamped claims, the payment that funded it, ' +
        'its result, and any verdict from a challenge or verify_claim call. Read-only, no network ' +
        'call. Use this to check what a prior pay_and_call actually produced, or whether a job you ' +
        'challenged (or verified) has since settled.',
      inputSchema,
      annotations: {
        title: 'Look up one job by id',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ jobId }) => {
      try {
        const job = await node.getJob(jobId);
        const summary =
          `Job "${job.jobId}" from provider "${job.provider}" (capability "${job.capabilityId}"). ` +
          `Status: ${job.status}. Funding payment: ${job.paymentTx}. Result: ${JSON.stringify(job.result)}. ` +
          `Claims: ${formatClaims(job)}. Verdict: ${formatVerdict(job)}.`;
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

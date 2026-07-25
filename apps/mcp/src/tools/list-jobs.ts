import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AssayNodePort } from '../node-port.js';
import { toToolError } from '../tool-error.js';

/**
 * Registers `list_jobs`: every job this node's store has ever created, in
 * creation order (issue #84). Read-only, no network call, no input. The
 * companion to `get_job`: use this first when you don't already have a
 * jobId in hand, e.g. to see everything paid for so far this session.
 */
export function registerListJobsTool(server: McpServer, node: AssayNodePort): void {
  server.registerTool(
    'list_jobs',
    {
      title: 'List every job on this node',
      description:
        'List every job this node has ever created (in creation order): jobId, provider, capability, ' +
        'status, and verdict if any. Read-only, no network call, no input. Use `get_job` afterwards ' +
        'for one job\'s full claims and result.',
      annotations: {
        title: 'List every job on this node',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const jobs = await node.listJobs();
        if (jobs.length === 0) {
          const text = 'No jobs yet: nothing has been paid for and served on this node so far.';
          return { content: [{ type: 'text', text }], structuredContent: { jobs } };
        }
        const lines = jobs
          .map((job) => {
            const verdict = job.verdict ? `, verdict ${job.verdict.valid ? 'valid' : 'invalid'}` : '';
            return `  ${job.jobId} -- ${job.provider} (${job.capabilityId}), status ${job.status}${verdict}`;
          })
          .join('\n');
        const summary = `${jobs.length} job(s):\n${lines}\n\nUse get_job with a specific jobId for the full claims and result.`;
        return {
          content: [{ type: 'text', text: summary }],
          structuredContent: { jobs } as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}

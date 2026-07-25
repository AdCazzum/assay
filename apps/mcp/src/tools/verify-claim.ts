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
      'The `k` of the specific claim to check, e.g. "liquidityUsd". Must be one of the keys in ' +
        'that job\'s claims (see get_job to see them all).',
    ),
};

/**
 * Registers `verify_claim`: `challenge`'s read-only sibling (issue #84, the
 * fix for the demo's last disclosed asterisk -- see the module doc comment
 * below). Re-derives one claim from The Graph, at that exact claim's own
 * `atBlock`, and reports the claimed value next to what the chain says now,
 * so the calling agent can decide *for itself* whether a claim is false
 * before ever spending its one `challenge` call on it. Never moves the job,
 * never slashes anything, and can be called as many times as useful.
 *
 * Why this exists: before this tool, the only way to dispute a claim was
 * `challenge` itself, a committing action -- there was no way for an agent to
 * check first. SPEC.md §16 risk 5 and the design review on #83 both name the
 * consequence: the watchdog had to be told which job/claim to look at, and
 * the demo disclosed that on stage as scripted. This tool is what lets an
 * agent reach "this claim is false, I am challenging it" on its own
 * evidence instead.
 */
export function registerVerifyClaimTool(server: McpServer, node: AssayNodePort): void {
  server.registerTool(
    'verify_claim',
    {
      title: 'Check whether a claim is true, without disputing it',
      description:
        'Re-derive one factual claim from a served job against The Graph, at the exact block that ' +
        'claim was originally stamped at, and report what was claimed next to what the chain reports ' +
        'now, plus how far apart they are. This is READ-ONLY: unlike `challenge`, it never moves the ' +
        'job and never touches the provider\'s bond or reputation, and it costs nothing to call more ' +
        'than once (it is idempotent: calling it again re-checks the same claim against the same ' +
        'block and gets the same answer). Use this first, on any claim you are suspicious of, to see ' +
        'the actual evidence before deciding whether to spend `challenge` (which IS a commitment: it ' +
        'moves the job and, if the claim turns out false, slashes the provider for real). A claim can ' +
        'come back true (the provider was honest) or false (the provider lied) -- read the numbers, ' +
        'not just the verdict label, since that is what your own reasoning about whether to challenge ' +
        'should be based on.',
      inputSchema,
      annotations: {
        title: 'Check whether a claim is true, without disputing it',
        // Deliberately the mirror image of `challenge`'s `false, false`: this
        // tool never writes anything and always gives the same answer for
        // the same job/claim (SPEC.md §12: verification is pinned to the
        // claim's own atBlock, never the current chain head), so both hints
        // are honestly `true` here in a way they cannot be for `challenge`.
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ jobId, claimKey }) => {
      try {
        const { claims, verdict } = await node.verifyClaim(jobId, claimKey);
        const claim = claims.find((c) => c.k === claimKey);
        const claimedLine = claim
          ? `Claimed: "${claimKey}" = ${JSON.stringify(claim.v)}, stamped at block ${claim.atBlock}.`
          : `Claimed: (no claim named "${claimKey}" was found on this job -- unexpected, report this).`;
        const verdictLine = verdict.valid
          ? 'Verdict: TRUE. Re-derived from The Graph at that same block, the claim holds up. Nothing ' +
            'to challenge here.'
          : `Verdict: FALSE. ${
              verdict.reason ??
              `Re-derived from The Graph at that same block, "${verdict.badClaim ?? claimKey}" does not match.`
            }`;
        const summary =
          `${claimedLine}\n${verdictLine}\n\n` +
          (verdict.valid
            ? 'No action needed: this claim is accurate as of the block it was stamped at.'
            : 'The claimed value and the chain\'s own re-derivation disagree at the same block, which ' +
              'means the provider misreported this claim. If you judge this worth disputing, call ' +
              '`challenge` with this same jobId and claimKey: that is the action that actually slashes ' +
              'the provider\'s bond and drops its reputation. This call alone changed nothing.');
        return {
          content: [{ type: 'text', text: summary }],
          structuredContent: { jobId, claimKey, claims, verdict } as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}

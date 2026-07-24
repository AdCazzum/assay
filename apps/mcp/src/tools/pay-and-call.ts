import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PayDeclinedError } from '@assay/core';
import type { AssayNodePort } from '../node-port.js';
import { toToolError } from '../tool-error.js';

const inputSchema = {
  capabilityId: z
    .string()
    .min(1)
    .describe('The provider to call, matching a prior discover() result: its full ENS name, e.g. "rugscore.assay.eth".'),
  // Rug-score is the only real capability this build instantiates (SPEC.md
  // §1), and its request IS a token address, so a plain string is the
  // honest, model-facing schema for today, not an accident: see the module
  // doc comment below. Generalizing this to a capability-agnostic shape is
  // future work for whenever a second capability actually exists.
  request: z
    .string()
    .min(1)
    .describe(
      'The capability-specific request payload. For "rugscore" this is the ERC-20 token ' +
        'contract address (0x...) on Ethereum mainnet to score.',
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      'Set true only after a prior call with this same request was declined (see the decline ' +
        'message) and you have weighed its violations and still judge this provider worth ' +
        'paying. This bypasses the pay/decline policy floor on purpose; it still spends real ' +
        'testnet HBAR and still runs the capability for real. Leave unset (or false) on a first ' +
        'attempt.',
    ),
};

/**
 * Registers `pay_and_call`: pays the provider's price on Hedera testnet,
 * confirms it via the mirror node, and has the provider run the capability
 * (SPEC.md §7 steps 3-4). This is the tool with real value moving on-chain,
 * so its description says so plainly and tells the agent to have made the
 * pay/no-pay call itself first via `discover`.
 *
 * `request` is typed as a plain, non-empty string rather than something
 * capability-agnostic (`unknown`/a discriminated union). That is a
 * conscious trade, not an oversight (issue #46): rug-score is the one real
 * capability this build instantiates, and its request genuinely is a token
 * address, so a plain string is the most honest, least-surprising
 * model-facing schema right now. It stops being the right call the moment a
 * second capability with a differently-shaped request exists.
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
        'disagrees. By default this is also checked against a pay/decline policy floor; if that ' +
        'declines, you get back the reason and every violated signal, not just an opaque failure, ' +
        'and can call this again with force: true if you judge it worth overriding.',
      inputSchema,
      annotations: {
        title: 'Pay a provider and call its capability',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ capabilityId, request, force }) => {
      try {
        const job = await node.payAndCall(capabilityId, request, force);
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
        if (err instanceof PayDeclinedError) {
          return formatPayDeclined(err);
        }
        return toToolError(err);
      }
    },
  );
}

/**
 * Turns a `PayDeclinedError` into a useful, actionable result (issue #46)
 * instead of the opaque one-line failure `toToolError` would otherwise
 * produce: the full assessment, every violated signal with its severity, and
 * an explicit pointer to the `force: true` override. `isError` stays `true`
 * (no payment happened, no job was created), but the content is meant to be
 * read and acted on, not just surfaced as "it failed".
 */
function formatPayDeclined(err: PayDeclinedError): CallToolResult {
  const violationLines = err.violations
    .map((violation) => `  [${violation.severity.toUpperCase()}] ${violation.key}: ${violation.detail}`)
    .join('\n');
  const text =
    `Declined to pay "${err.providerName}". No payment was made and no job was created.\n\n` +
    `Violations:\n${violationLines}\n\n` +
    'If, having read the violations above, you still judge this provider worth paying ' +
    '(e.g. one old slash on an otherwise long, clean record), call pay_and_call again with ' +
    'the same capabilityId and request plus force: true to bypass this floor. That still spends ' +
    'real testnet HBAR, so only do it having actually weighed the violations, not reflexively.';
  return {
    isError: true,
    content: [{ type: 'text', text }],
    structuredContent: {
      declined: true,
      providerName: err.providerName,
      reason: err.message,
      violations: err.violations,
      assessment: err.assessment,
    } as unknown as Record<string, unknown>,
  };
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RegisterProgress } from '@assay/core';
import type { AssayNodePort } from '../node-port.js';
import { toToolError } from '../tool-error.js';

const inputSchema = {
  label: z
    .string()
    .min(1)
    .refine((v) => !v.includes('.'), {
      message:
        'must be a bare subname label with no dots, e.g. "myagent" -- the full ENS name is built ' +
        'automatically as "<label>.<parent>"',
    })
    .describe(
      'The bare subname label to register under the Assay parent ENS name, e.g. "myagent" (not ' +
        '"myagent.assay.eth" -- the parent is appended automatically). Must not already be a name ' +
        'you rely on: this posts a real bond and publishes a real manifest under it immediately.',
    ),
  capabilityId: z
    .string()
    .min(1)
    .describe(
      'The capability registry id this manifest advertises, e.g. "rugscore". This must match a ' +
        'capability id this node actually has an implementation for, or a later pay_and_call against ' +
        'this new name will resolve the manifest fine but fail to run anything. This build only has ' +
        'a real implementation for "rugscore"; registering any other id publishes a manifest nobody ' +
        'can actually serve yet.',
    ),
  description: z.string().min(1).describe('Human-readable description of what this capability does.'),
  priceHbar: z.number().positive().describe('Price per call, in HBAR.'),
  endpoint: z
    .string()
    .min(1)
    .describe(
      'Informational endpoint URL for this provider. This build runs the capability in-process ' +
        'once payment confirms, it does not actually dispatch a request to this URL; it is published ' +
        'as part of the manifest for anyone reading it off ENS directly.',
    ),
  verifierHash: z
    .string()
    .min(1)
    .describe(
      'A commitment to the verifier code that will adjudicate a future challenge against this ' +
        'provider (SPEC.md §5): a real hash over the actual verifier source, not a placeholder, so ' +
        'this provider cannot quietly relax its own verifier after taking payment. If reusing the ' +
        'rug-score capability, compute this with @assay/cap-rugscore\'s computeVerifierHash.',
    ),
  bondHbar: z
    .number()
    .positive()
    .describe(
      'HBAR to post as this provider\'s bond, real testnet HBAR that actually leaves the operator ' +
        'account. A thin bond relative to priceHbar reads as weak collateral to any requester\'s own ' +
        'assessment (see discover/list_providers): aim for several times the price, not just above it.',
    ),
};

const REGISTER_PHASE_ORDER: RegisterProgress['phase'][] = [
  'posting-bond',
  'publishing-manifest',
  'initializing-reputation',
  'done',
];

/** One human-readable line per `RegisterProgress` phase, for both the streamed progress notifications and (if a client ignores those) the final summary's own recap. */
function describeRegisterProgress(progress: RegisterProgress): string {
  switch (progress.phase) {
    case 'posting-bond':
      return 'Posting bond on Hedera testnet...';
    case 'publishing-manifest':
      return `Bond posted (tx ${progress.bondTxId}). Publishing manifest to ENS...`;
    case 'initializing-reputation':
      return `Manifest published (tx ${progress.manifestTxHash}). Initializing reputation on ENS...`;
    case 'done':
      return `Done: bond ${progress.result.bondRef}, manifest tx ${progress.result.manifestTxHash}, ` +
        `reputation tx ${progress.result.reputationTxHash}.`;
    default:
      return progress satisfies never;
  }
}

/**
 * Registers `register_provider`: an agent claiming its own identity (issue
 * #84). Reuses `@assay/core`'s `register()` end to end (bond, then manifest,
 * then reputation, in that forced order -- never reimplemented here): a real
 * Hedera bond and two real ENS writes, ~25s measured
 * (docs/demo-run-sheet.md). This is the one non-read-only tool in this file
 * besides `pay_and_call`, and the only one that creates a new identity
 * rather than acting on an existing one.
 *
 * Because it is slow, progress streams as an MCP `notifications/progress`
 * message per phase boundary whenever the calling client attaches a
 * `_meta.progressToken` to its request (the standard MCP mechanism a client
 * opts into by passing an `onprogress` callback -- most MCP SDK clients,
 * including Claude Code's own, do this for free). A client that does not
 * request progress still gets the final result; nothing here blocks on
 * whether anyone is listening.
 */
export function registerRegisterProviderTool(server: McpServer, node: AssayNodePort): void {
  server.registerTool(
    'register_provider',
    {
      title: 'Register a new provider identity under the Assay parent name',
      description:
        'Claim a brand-new provider identity: post a real bond on Hedera testnet, then publish a ' +
        'manifest and initialize reputation as ENS text records under a subname of the Assay parent ' +
        'name (no on-chain name creation needed -- any label is immediately writable through the ' +
        'wildcard resolver). This SPENDS real testnet HBAR (the bond) and takes roughly 25 seconds ' +
        '(a bond confirmation plus two ENS writes, run strictly in that order because the manifest ' +
        'must carry the bond\'s real reference). The resulting name is discoverable immediately ' +
        'afterwards through `discover` or `list_providers`, and payable through `pay_and_call`, ' +
        'exactly like any other provider on this rail. Only call this to actually create a new, ' +
        'real, bonded identity, never speculatively.',
      inputSchema,
      annotations: {
        title: 'Register a new provider identity under the Assay parent name',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ label, capabilityId, description, priceHbar, endpoint, verifierHash, bondHbar }, extra) => {
      try {
        const progressToken = extra._meta?.progressToken;
        const onProgress =
          progressToken === undefined
            ? undefined
            : (progress: RegisterProgress) => {
                extra
                  .sendNotification({
                    method: 'notifications/progress',
                    params: {
                      progressToken,
                      progress: REGISTER_PHASE_ORDER.indexOf(progress.phase) + 1,
                      total: REGISTER_PHASE_ORDER.length,
                      message: describeRegisterProgress(progress),
                    },
                  })
                  .catch(() => {
                    // Narration must never break registration; see AssayNodeConfig.onLoopEvent's
                    // doc comment in @assay/core for the same posture applied here.
                  });
              };

        const manifest = { capabilityId, description, priceHbar, endpoint, verifierHash };
        const result = await node.registerProvider(label, manifest, bondHbar, onProgress);

        const summary =
          `Registered "${result.name}". Bond: ref "${result.bondRef}", tx ${result.bondTxId}. ` +
          `Manifest tx: ${result.manifestTxHash}. Reputation tx: ${result.reputationTxHash}. ` +
          `Reputation now: score ${result.reputation.score}, ${result.reputation.jobs} jobs, ` +
          `${result.reputation.slashes} slashes, bond ${result.reputation.bondHbar} HBAR. ` +
          `This name is live now: call discover("${result.name}") or pay_and_call against it like ` +
          'any other provider.';
        return {
          content: [{ type: 'text', text: summary }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}

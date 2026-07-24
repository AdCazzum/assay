import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Turns whatever a tool handler threw into a `CallToolResult` the calling
 * agent can actually recover from mid-demo: a plain-text error message
 * (never a raw stack trace) with `isError: true`, so a client that only reads
 * `content` still sees the reason, not a bare RPC failure.
 *
 * Anything with a `.message` (all our named errors, e.g.
 * `UnknownCapabilityError`) is passed through as-is, since those are already
 * written to be readable and self-diagnosing. Anything else is stringified
 * plainly instead of dropped.
 */
export function toToolError(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

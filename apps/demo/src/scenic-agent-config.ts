/**
 * Pure config-building helpers for the real headless Claude agent the
 * scenic runner spawns (`scenic-runner.ts`). Split out so the shape of the
 * generated MCP config and the `claude` CLI args are unit-testable without
 * actually spawning a process.
 *
 * Mirrors `apps/mcp/scripts/run-agent.ts`'s own `buildMcpConfig` shape
 * exactly, with the one addition issue #93's transport needs: an explicit
 * `env` map on the `assay` server entry carrying
 * `ASSAY_LOOP_EVENTS_SINK` (belt-and-suspenders over ambient env
 * inheritance across the two process forks -- `claude` spawning the MCP
 * server as its own child -- which the design doc flags as unverified
 * rather than assumed; see `docs/demo-run-sheet.md`'s "STILL PENDING" notes
 * and the PR description for what running this for real confirmed).
 */

export type ScenicMcpConfig = {
  mcpServers: {
    assay: {
      command: string;
      args: string[];
      cwd: string;
      env: Record<string, string | undefined>;
    };
  };
};

export function buildScenicMcpConfig(opts: { repoRoot: string; sinkPath: string }): ScenicMcpConfig {
  return {
    mcpServers: {
      assay: {
        command: 'pnpm',
        args: ['--filter', '@assay/mcp', 'exec', 'tsx', 'src/index.ts'],
        cwd: opts.repoRoot,
        env: { ...process.env, ASSAY_LOOP_EVENTS_SINK: opts.sinkPath },
      },
    },
  };
}

/**
 * Matches `apps/mcp/agent/prompt.md`'s literal tool list (issue #94's
 * mission prompt) and `apps/mcp/scripts/run-agent.ts`'s own `ALLOWED_TOOLS`
 * -- kept in sync by hand across the two files (a demo script importing from
 * an app's own `scripts/` directory would reach past that app's public
 * surface, the same layering reason `packages/registry/scripts/reset-demo-state.ts`
 * repeats `LYING_CAPABILITY_ID` as a literal rather than importing it).
 * `register_provider` is deliberately excluded -- the mission never asks the
 * agent to register anything.
 */
export const SCENIC_ALLOWED_TOOLS =
  'mcp__assay__list_providers mcp__assay__discover mcp__assay__pay_and_call mcp__assay__verify_claim ' +
  'mcp__assay__challenge mcp__assay__rate mcp__assay__get_job mcp__assay__list_jobs';

export function buildClaudeArgs(opts: { prompt: string; mcpConfigPath: string; maxBudgetUsd: string }): string[] {
  return [
    '-p',
    opts.prompt,
    '--mcp-config',
    opts.mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools',
    SCENIC_ALLOWED_TOOLS,
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-budget-usd',
    opts.maxBudgetUsd,
    '--no-session-persistence',
  ];
}

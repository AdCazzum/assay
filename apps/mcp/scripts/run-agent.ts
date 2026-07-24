#!/usr/bin/env tsx
/**
 * Drives a real, headless Claude Code agent through the Assay MCP server
 * (issue #24): registers the `assay` tools (`discover` / `pay_and_call` /
 * `challenge` / `rate`) with `claude -p`, hands it the verbatim prompt from
 * `agent/prompt.md`, and captures the full transcript.
 *
 * Usage (from the repo root):
 *
 *   pnpm --filter @assay/mcp exec tsx scripts/run-agent.ts --target live
 *   pnpm --filter @assay/mcp exec tsx scripts/run-agent.ts --target good-provider
 *   pnpm --filter @assay/mcp exec tsx scripts/run-agent.ts --target bad-provider
 *
 * `--target live` points the agent at the real `AssayNodePort`
 * (`src/index.ts`'s `buildLiveNodeFromEnv`): a real Sepolia ENS read, and if
 * the agent decides to pay, a real Hedera testnet payment and a real Graph
 * query. This spends real testnet HBAR and real Claude API usage.
 *
 * `--target good-provider` and `--target bad-provider` point the agent at
 * declared fixture servers instead (`src/demo/serve-good-provider.ts` /
 * `src/demo/serve-bad-provider.ts`). See `src/demo/good-provider-node.ts`,
 * `src/demo/bad-provider-node.ts` and `agent/README.md` for exactly what is
 * real and what is staged in each, and why: in short, there is only one live
 * ENS registration for this capability, and its current live reputation
 * happens to argue against paying (see `agent/README.md`'s live run notes),
 * so these two fixtures give the agent both sides of the pay/decline
 * contrast the demo needs.
 *
 * All three runs get the byte-identical prompt, the byte-identical
 * `capabilityId` (`"rugscore.assay.eth"`), and the byte-identical
 * `--allowedTools` set; the only thing that differs between invocations is
 * which process backs the `assay` MCP server, i.e. which provider record
 * `discover("rugscore.assay.eth")` resolves to. There is no branch anywhere
 * in this repo's code that picks the outcome: the model's own reasoning
 * does.
 *
 * Writes two transcripts per run to `agent/transcripts/`: the raw
 * `stream-json` NDJSON from `claude`, and a readable `.md` rendering of it
 * (assistant text, tool calls, tool results, in order).
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(MCP_ROOT, '..', '..');

type Target = 'live' | 'good-provider' | 'bad-provider';

const ENTRY_POINT: Record<Target, string> = {
  live: 'src/index.ts',
  'good-provider': 'src/demo/serve-good-provider.ts',
  'bad-provider': 'src/demo/serve-bad-provider.ts',
};

const ALLOWED_TOOLS =
  'mcp__assay__discover mcp__assay__pay_and_call mcp__assay__challenge mcp__assay__rate';

type CliOptions = {
  target: Target;
  maxBudgetUsd: string;
};

function parseArgs(argv: string[]): CliOptions {
  const targetIdx = argv.indexOf('--target');
  const target = targetIdx >= 0 ? argv[targetIdx + 1] : undefined;
  if (target !== 'live' && target !== 'good-provider' && target !== 'bad-provider') {
    console.error(
      'Usage: tsx scripts/run-agent.ts --target live|good-provider|bad-provider [--max-budget-usd N]',
    );
    process.exit(1);
  }
  const budgetIdx = argv.indexOf('--max-budget-usd');
  const maxBudgetUsd = budgetIdx >= 0 ? (argv[budgetIdx + 1] ?? '2') : '2';
  return { target, maxBudgetUsd };
}

/**
 * The MCP config handed to `claude --mcp-config`. Self-resolved from this
 * script's own location every run (rather than trusting the absolute
 * `cwd` baked into the checked-in `agent/mcp-config.*.json` templates),
 * so this works from whatever checkout or worktree it is actually run from.
 * Those checked-in files exist to document the shape for a human wiring
 * this server into their own Claude Desktop config, not as what this script
 * executes.
 */
function buildMcpConfig(target: Target) {
  return {
    mcpServers: {
      assay: {
        command: 'pnpm',
        args: ['--filter', '@assay/mcp', 'exec', 'tsx', ENTRY_POINT[target]],
        cwd: REPO_ROOT,
      },
    },
  };
}

/**
 * Deliberately loose rather than a strict discriminated union: this only
 * renders a best-effort readable transcript from whatever shape `claude
 * --output-format stream-json` happens to emit, it never drives program
 * logic, so a union `claude` doesn't exactly match should still render
 * gracefully instead of failing to typecheck.
 */
type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
};

type StreamEvent = {
  type?: string;
  message?: { content?: ContentBlock[] };
  [key: string]: unknown;
};

function toText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text ?? '') : ''))
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

/** Renders the raw `stream-json` NDJSON lines into a readable transcript: assistant text, tool calls, tool results, in order. */
function renderReadableTranscript(target: Target, lines: string[]): string {
  const out: string[] = [
    `# Assay agent transcript — target: ${target}`,
    '',
    `Generated by \`apps/mcp/scripts/run-agent.ts\`. Prompt: \`apps/mcp/agent/prompt.md\` (verbatim, unedited).`,
    '',
  ];

  for (const line of lines) {
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }

    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text?.trim()) {
          out.push('### assistant', '', block.text.trim(), '');
        } else if (block.type === 'tool_use') {
          out.push(`### tool_use: ${block.name ?? '(unknown)'}`, '', '```json', JSON.stringify(block.input, null, 2), '```', '');
        }
      }
    } else if (event.type === 'user' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_result') {
          out.push(
            `### tool_result${block.is_error ? ' (error)' : ''}`,
            '',
            '```',
            toText(block.content).trim(),
            '```',
            '',
          );
        }
      }
    } else if (event.type === 'result') {
      out.push('### result', '', '```json', JSON.stringify(event, null, 2), '```', '');
    }
  }

  return out.join('\n');
}

async function main(): Promise<void> {
  const { target, maxBudgetUsd } = parseArgs(process.argv.slice(2));

  const prompt = readFileSync(path.join(MCP_ROOT, 'agent', 'prompt.md'), 'utf8');

  const configPath = path.join(MCP_ROOT, 'agent', `.mcp-config.${target}.generated.json`);
  writeFileSync(configPath, JSON.stringify(buildMcpConfig(target), null, 2));

  const transcriptsDir = path.join(MCP_ROOT, 'agent', 'transcripts');
  mkdirSync(transcriptsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rawPath = path.join(transcriptsDir, `${target}-${stamp}.stream.jsonl`);
  const readablePath = path.join(transcriptsDir, `${target}-${stamp}.md`);

  console.error(`[run-agent] target=${target}`);
  console.error(`[run-agent] mcp config: ${configPath}`);
  console.error(`[run-agent] raw transcript -> ${rawPath}`);
  console.error(`[run-agent] readable transcript -> ${readablePath}`);

  const claudeArgs = [
    '-p',
    prompt,
    '--mcp-config',
    configPath,
    '--strict-mcp-config',
    '--allowedTools',
    ALLOWED_TOOLS,
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-budget-usd',
    maxBudgetUsd,
    '--no-session-persistence',
  ];

  const child = spawn('claude', claudeArgs, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'inherit'] });

  const lines: string[] = [];
  let buffered = '';
  child.stdout.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
    buffered += chunk.toString('utf8');
    const parts = buffered.split('\n');
    buffered = parts.pop() ?? '';
    for (const part of parts) {
      if (part.trim()) lines.push(part);
    }
  });

  const exitCode: number = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
  });
  if (buffered.trim()) lines.push(buffered);

  writeFileSync(rawPath, lines.join('\n') + '\n');
  writeFileSync(readablePath, renderReadableTranscript(target, lines));

  console.error(`[run-agent] claude exited ${exitCode}`);
  console.error(`[run-agent] wrote ${rawPath}`);
  console.error(`[run-agent] wrote ${readablePath}`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('[run-agent] failed:', err);
  process.exit(1);
});

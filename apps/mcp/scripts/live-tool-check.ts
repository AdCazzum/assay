#!/usr/bin/env tsx
/**
 * Live evidence for issue #84: boots the real Assay MCP server(s) over
 * stdio and drives them with a real `@modelcontextprotocol/sdk` `Client`
 * (the same pattern #23/#46 used), listing every tool and calling each of
 * the five new ones for real.
 *
 * Three server processes, each spawned exactly the way `agent:*` scripts
 * already do (`pnpm --filter @assay/mcp exec tsx <entry>`):
 *
 *  - `src/index.ts` (the real live node): real Sepolia ENS, real Hedera
 *    testnet, real Graph. Used for `list_providers`, `register_provider`,
 *    `get_job`/`list_jobs`, and the full tool listing.
 *  - `src/demo/serve-good-provider.ts`: real Hedera + Graph + the honest
 *    rug-score capability, over a declared fixture registry (see that
 *    file's own doc comment). Used for `verify_claim`'s honest leg.
 *  - `src/demo/serve-lying-provider.ts`: same real Hedera + Graph, but the
 *    declared lying-provider capability harness. Used for `verify_claim`'s
 *    tampered leg.
 *
 * Usage: `pnpm --filter @assay/mcp exec tsx scripts/live-tool-check.ts`
 * (needs `.env` at the repo root, see AGENTS.md). Spends real testnet HBAR
 * (one register_provider bond + two pay_and_call payments).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(MCP_ROOT, '..', '..');

const GOODCAT = '0xd6c68bc8c862722e140e7b339ddf8a144a7d3530';

function section(title: string): void {
  console.log(`\n${'='.repeat(8)} ${title} ${'='.repeat(8)}`);
}

/**
 * Deliberately loose (not `CallToolResult`, whose SDK-inferred union is
 * awkward to satisfy from a plain call site -- same posture
 * `scripts/run-agent.ts`'s own `ContentBlock`/`StreamEvent` types take):
 * this only renders a best-effort readable line, it never drives program
 * logic.
 */
function text(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const first = content?.[0];
  return first?.text ?? '(no text content)';
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

async function connect(entry: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: 'pnpm',
    args: ['--filter', '@assay/mcp', 'exec', 'tsx', entry],
    cwd: REPO_ROOT,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'issue-84-live-check', version: '0.0.0' });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

async function main(): Promise<void> {
  // --- Leg 1: the real live node -------------------------------------
  section('live node (src/index.ts): list tools, list_providers, register_provider, get_job/list_jobs');
  const live = await connect('src/index.ts');
  try {
    const { tools } = await live.client.listTools();
    console.log(
      'Tools:',
      tools.map((t) => t.name).sort(),
    );
    const verifyClaimTool = tools.find((t) => t.name === 'verify_claim')!;
    const challengeTool = tools.find((t) => t.name === 'challenge')!;
    console.log('verify_claim annotations:', verifyClaimTool.annotations);
    console.log('challenge annotations:', challengeTool.annotations);

    section('list_providers (real ENS resolves of rugscore.assay.eth / liar.assay.eth)');
    const listProvidersResult = await live.client.callTool({ name: 'list_providers', arguments: {} });
    console.log(text(listProvidersResult));

    section('list_jobs (before anything paid on this node)');
    console.log(text(await live.client.callTool({ name: 'list_jobs', arguments: {} })));

    section('get_job on an unknown id (error UX check)');
    console.log(text(await live.client.callTool({ name: 'get_job', arguments: { jobId: 'no-such-job' } })));

    section('register_provider: a brand-new, real subname (real bond + two real ENS writes, ~25s)');
    const label = `mcp84check${Date.now().toString(36)}`;
    const registerResult = await live.client.callTool(
      {
        name: 'register_provider',
        arguments: {
          label,
          capabilityId: 'rugscore',
          description: 'issue #84 live-evidence self-registration, safe to ignore/reuse',
          priceHbar: 1,
          endpoint: 'https://example.invalid/issue-84-live-check',
          verifierHash: '0xissue84livecheck',
          bondHbar: 1,
        },
      },
      undefined,
      {
        onprogress: (progress) => {
          console.log(`[progress] ${progress.progress}/${progress.total}: ${progress.message}`);
        },
      },
    );
    console.log(text(registerResult));

    section('list_providers again does NOT include the freshly-registered name (candidate set is configured, not live-searched)');
    console.log(text(await live.client.callTool({ name: 'list_providers', arguments: {} })));

    section('but discover() resolves the freshly-registered name directly, proving the write really landed');
    console.log(
      text(await live.client.callTool({ name: 'discover', arguments: { capabilityId: `${label}.assay.eth` } })),
    );
  } finally {
    await live.close();
  }

  // --- Leg 2: verify_claim, honest capability -------------------------
  section('verify_claim, HONEST leg (serve-good-provider.ts: real Hedera + Graph, honest rug-score capability)');
  const good = await connect('src/demo/serve-good-provider.ts');
  let honestJobId: string;
  try {
    const paid = await good.client.callTool({
      name: 'pay_and_call',
      arguments: { capabilityId: 'rugscore.assay.eth', request: GOODCAT },
    });
    console.log(text(paid));
    honestJobId = structured(paid).jobId as string;

    section('verify_claim(honestJobId, "liquidityUsd") -- expect TRUE');
    console.log(
      text(
        await good.client.callTool({
          name: 'verify_claim',
          arguments: { jobId: honestJobId, claimKey: 'liquidityUsd' },
        }),
      ),
    );
  } finally {
    await good.close();
  }

  // --- Leg 3: verify_claim, tampered capability ------------------------
  section('verify_claim, TAMPERED leg (serve-lying-provider.ts: real Hedera + Graph, LYING rug-score capability, DECLARED test harness)');
  const lying = await connect('src/demo/serve-lying-provider.ts');
  try {
    const paid = await lying.client.callTool({
      name: 'pay_and_call',
      arguments: { capabilityId: 'rugscore.assay.eth', request: GOODCAT },
    });
    console.log(text(paid));
    const lyingJobId = structured(paid).jobId as string;

    section('verify_claim(lyingJobId, "liquidityUsd") -- expect FALSE, claimed vs chain numbers visible');
    console.log(
      text(
        await lying.client.callTool({
          name: 'verify_claim',
          arguments: { jobId: lyingJobId, claimKey: 'liquidityUsd' },
        }),
      ),
    );
  } finally {
    await lying.close();
  }

  section('DONE');
}

main().catch((err) => {
  console.error('[live-tool-check] failed:', err);
  process.exit(1);
});

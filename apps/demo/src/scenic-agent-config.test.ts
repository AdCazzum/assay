import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, buildScenicMcpConfig, SCENIC_ALLOWED_TOOLS } from './scenic-agent-config.js';

describe('buildScenicMcpConfig', () => {
  it('carries the sink path via an explicit env map, not just ambient inheritance', () => {
    const config = buildScenicMcpConfig({ repoRoot: '/repo', sinkPath: '/tmp/sink.ndjson' });
    expect(config.mcpServers.assay.env.ASSAY_LOOP_EVENTS_SINK).toBe('/tmp/sink.ndjson');
    expect(config.mcpServers.assay.cwd).toBe('/repo');
  });

  it('still spawns the real @assay/mcp server entry point, not a fixture', () => {
    const config = buildScenicMcpConfig({ repoRoot: '/repo', sinkPath: '/tmp/sink.ndjson' });
    expect(config.mcpServers.assay.args).toContain('src/index.ts');
    expect(config.mcpServers.assay.args).toContain('@assay/mcp');
  });
});

describe('buildClaudeArgs', () => {
  it('includes every tool the mission prompt names, and excludes register_provider', () => {
    const args = buildClaudeArgs({ prompt: 'p', mcpConfigPath: '/tmp/c.json', maxBudgetUsd: '4' });
    const idx = args.indexOf('--allowedTools');
    const tools = args[idx + 1];
    for (const tool of ['list_providers', 'discover', 'pay_and_call', 'verify_claim', 'challenge', 'rate', 'get_job', 'list_jobs']) {
      expect(tools).toContain(`mcp__assay__${tool}`);
    }
    expect(tools).not.toContain('register_provider');
  });

  it('passes the prompt and mcp config path through unmodified', () => {
    const args = buildClaudeArgs({ prompt: 'the mission text', mcpConfigPath: '/tmp/c.json', maxBudgetUsd: '4' });
    expect(args).toContain('the mission text');
    expect(args).toContain('/tmp/c.json');
  });
});

describe('SCENIC_ALLOWED_TOOLS', () => {
  it('is a space-separated flat list (the shape --allowedTools expects)', () => {
    expect(SCENIC_ALLOWED_TOOLS.split(' ').every((t) => t.startsWith('mcp__assay__'))).toBe(true);
  });
});

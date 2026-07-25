/**
 * The scenic runner (issues #93/#94): a real, autonomous Claude agent driving
 * the real MCP server against live networks, with its reasoning and the
 * loop's real chain state on one screen, side by side. Replaces the keypress
 * runner from #86 entirely -- no keypresses drive the loop, the agent does.
 *
 * **What this composes, and what it reuses rather than reinvents** (see each
 * module's own doc comment for the reasoning):
 *  - `scenic-agent-config.ts` — the generated MCP config (carrying
 *    `ASSAY_LOOP_EVENTS_SINK` explicitly) and the `claude` CLI args.
 *  - `agent-stream.ts` — parses the spawned agent's own `stream-json` stdout.
 *  - `sink-tailer.ts` — polls the sink file `apps/mcp`'s server writes to
 *    (issue #93), split-and-hold-remainder, exactly like the agent's own
 *    stdout chunking already needs.
 *  - `scenic-loop-mapper.ts` — maps a parsed sink line onto
 *    `@assay/dashboard`'s `LoopEvent`, reusing `createCoreEventMapper()` and
 *    this app's own already-tested `formatReputationHeartbeat()` verbatim.
 *  - `scenic-frame.ts` — composes one screen frame, reusing
 *    `@assay/dashboard`'s `renderState()` verbatim for the loop column.
 *  - `scenic-capture.ts` — records every raw line from both sources
 *    (relative-timestamped) so a run can be replayed offline later, and
 *    drives that replay back through this exact same parsing/mapping/framing
 *    pipeline (not a second, parallel implementation).
 *
 * **Ordering, deliberately simplified** (see the design doc): the agent pane
 * is its own chronological scroll (ordered by this process's own receipt
 * time); the loop pane is a fold to current state per step, ordered among
 * itself by `seq`. No cross-process clock reconciliation is attempted.
 *
 * **Silence strategy**: redraw on whichever comes first — a new line from
 * either source, or a bare wall-clock tick (`REDRAW_TICK_MS`) if neither has
 * fired. Every elapsed-time figure on screen is computed from `Date.now()`
 * at render time, never from the last line received, so it climbs visibly
 * even during total silence on both streams (see `scenic-hud.ts`).
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { applyEvent, initialLoopState, type LoopState } from '@assay/dashboard';
import { buildClaudeArgs, buildScenicMcpConfig } from './scenic-agent-config.js';
import { createAgentTranscript, type AgentPaneLine } from './agent-stream.js';
import { parseSinkLine, splitLines, startSinkTailer } from './sink-tailer.js';
import { createScenicLoopMapper } from './scenic-loop-mapper.js';
import { composeSceneFrame } from './scenic-frame.js';
import { isLoopStreamStale } from './scenic-hud.js';
import { createScenicRecorder, readScenicCapture, replayScenicCapture, type ScenicRecord } from './scenic-capture.js';
import { wrapText } from './wrap-text.js';
import { startKeyboard } from './keys.js';
import { buildLiveDemoNodes, MissingConfigError } from './live-node.js';
import { checkDemoReadiness } from './reset-check.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const PROMPT_PATH = path.join(REPO_ROOT, 'apps', 'mcp', 'agent', 'prompt.md');
const CAPTURES_DIR = path.join(HERE, '..', 'captures');
const REDRAW_TICK_MS = 500;
const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const STALE_THRESHOLD_MS = 15_000;
const DEFAULT_MAX_BUDGET_USD = '4';

loadEnv({ path: path.join(REPO_ROOT, '.env') });

function shortId(): string {
  return randomBytes(3).toString('hex');
}

type Writer = { write(chunk: string): unknown };

/**
 * The live, shared render loop both `runScenicLive` and `runScenicRehearsal`
 * drive: one mutable frame of state, redrawn on whichever comes first (a new
 * parsed line, or the bare wall-clock tick). Kept as one small class so both
 * entrypoints share the exact same framing/staleness logic instead of two
 * near-duplicate copies.
 */
class ScenicScreen {
  private agentPaneLines: string[] = [];
  private loopState: LoopState = initialLoopState();
  private lastLoopEventAt: number | undefined;
  private footer: string[] = [];
  private readonly writer: Writer;
  private readonly replay: boolean;
  private readonly runLabel: string;
  private readonly startedAt: number;
  private readonly totalWidth: number;

  constructor(opts: { writer?: Writer; replay: boolean; runLabel: string; startedAt: number; totalWidth?: number }) {
    this.writer = opts.writer ?? process.stdout;
    this.replay = opts.replay;
    this.runLabel = opts.runLabel;
    this.startedAt = opts.startedAt;
    this.totalWidth = opts.totalWidth ?? 100;
  }

  pushAgentLine(line: AgentPaneLine): void {
    const prefix = { text: '▸ ', 'tool-call': '→ ', 'tool-result': '  ← ', status: '· ', verdict: '' }[line.kind];
    const leftWidth = Math.floor((this.totalWidth - 3) / 2);
    const wrapped = wrapText(`${prefix}${line.text}`, leftWidth, ' '.repeat(prefix.length));
    this.agentPaneLines.push(...wrapped);
  }

  applyLoopEvents(events: Parameters<typeof applyEvent>[1][], isRealLoopEvent: boolean): void {
    for (const event of events) this.loopState = applyEvent(this.loopState, event);
    if (isRealLoopEvent) this.lastLoopEventAt = Date.now();
  }

  setFooter(lines: string[]): void {
    this.footer = lines;
  }

  redraw(): void {
    const now = Date.now();
    const elapsedMs = now - this.startedAt;
    const loopLastEventAgoMs = this.lastLoopEventAt === undefined ? undefined : now - this.lastLoopEventAt;
    const stale = isLoopStreamStale(loopLastEventAgoMs, STALE_THRESHOLD_MS);
    const footerLines = [...this.footer];
    if (stale) {
      footerLines.unshift(
        `network looks stalled. last real loop event: ${((loopLastEventAgoMs ?? 0) / 1000).toFixed(0)}s ago. ` +
          'this can be a slow ENS write (measured up to 25s) or a dead network -- give it to 30s, then ctrl-c ' +
          'and run the rehearsal mode instead.',
      );
    }
    const frame = composeSceneFrame({
      hud: { elapsedMs, loopLastEventAgoMs, replay: this.replay, runLabel: this.runLabel, staleThresholdMs: STALE_THRESHOLD_MS },
      agentLines: this.agentPaneLines,
      loopState: this.loopState,
      footerLines,
      totalWidth: this.totalWidth,
    });
    this.writer.write(`${CLEAR_SCREEN}${frame}\n`);
  }
}

export type ScenicRunOptions = {
  maxBudgetUsd?: string;
  writer?: Writer;
  totalWidth?: number;
  /** Overrides where the capture file is written. Defaults to a timestamped file under `apps/demo/captures/`. */
  capturePath?: string;
};

/**
 * The pre-flight readiness check (issue #86/#64, kept exactly as it was:
 * "the readiness check" is one of the three things #94 names as genuinely
 * reusable). Builds its own short-lived live node purely to call
 * `.assess()`, then closes it -- the actual agent run below builds its own,
 * completely separate Hedera client inside the spawned MCP server process.
 */
async function checkReadyOrExplain(): Promise<{ ready: true; goodProviderName: string } | { ready: false }> {
  let nodes: ReturnType<typeof buildLiveDemoNodes>;
  try {
    nodes = buildLiveDemoNodes();
  } catch (err) {
    if (err instanceof MissingConfigError) {
      console.error(err.message);
      return { ready: false };
    }
    throw err;
  }
  try {
    const readiness = await checkDemoReadiness(nodes.requesterNode, nodes.goodProviderName);
    if (!readiness.ready) {
      console.error('NOT READY TO START:');
      console.error(readiness.reason);
      return { ready: false };
    }
    return { ready: true, goodProviderName: nodes.goodProviderName };
  } finally {
    nodes.close();
  }
}

/** Runs the real, live scenic demo end to end. Resolves once the agent process exits (or is aborted). */
export async function runScenicLive(opts: ScenicRunOptions = {}): Promise<{ exitCode: number; capturePath: string }> {
  const readiness = await checkReadyOrExplain();
  if (!readiness.ready) {
    return { exitCode: 1, capturePath: '' };
  }

  const runLabel = shortId();
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'assay-scenic-'));
  const sinkPath = path.join(workDir, 'events.ndjson');
  const configPath = path.join(workDir, 'mcp-config.json');
  writeFileSync(configPath, JSON.stringify(buildScenicMcpConfig({ repoRoot: REPO_ROOT, sinkPath }), null, 2));

  mkdirSync(CAPTURES_DIR, { recursive: true });
  const capturePath = opts.capturePath ?? path.join(CAPTURES_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${runLabel}.scenic.ndjson`);

  const prompt = readFileSync(PROMPT_PATH, 'utf8');
  const claudeArgs = buildClaudeArgs({ prompt, mcpConfigPath: configPath, maxBudgetUsd: opts.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD });

  const startedAt = Date.now();
  const recorder = createScenicRecorder(capturePath, startedAt);
  const screen = new ScenicScreen({ writer: opts.writer, replay: false, runLabel, startedAt, totalWidth: opts.totalWidth });
  const transcript = createAgentTranscript();
  const loopMapper = createScenicLoopMapper();
  let turns = 0;

  screen.setFooter([`sink: waiting for first event  ·  ctrl-c aborts → replay a captured run with: pnpm --filter @assay/demo exec tsx src/index.ts rehearsal`]);
  screen.redraw();

  const child: ChildProcessByStdio<null, Readable, Readable> = spawn('claude', claudeArgs, {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuffered = '';
  child.stdout.on('data', (chunk: Buffer) => {
    const { lines, remainder } = splitLines(stdoutBuffered, chunk.toString('utf8'));
    stdoutBuffered = remainder;
    for (const raw of lines) {
      recorder.record('agent', raw);
      const paneLines = transcript.handleLine(raw);
      for (const line of paneLines) {
        if (line.kind === 'tool-call') turns += 1;
        screen.pushAgentLine(line);
      }
      screen.redraw();
    }
  });

  let stderrTail = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
  });

  const tailer = startSinkTailer({
    path: sinkPath,
    onLine: (raw) => {
      recorder.record('loop', raw);
      const parsed = parseSinkLine(raw);
      const { events, isRealLoopEvent } = loopMapper(parsed);
      screen.applyLoopEvents(events, isRealLoopEvent);
      screen.redraw();
    },
  });

  const tickTimer = setInterval(() => {
    screen.setFooter([`agent: turn ${turns}  ·  ctrl-c aborts → replay this run with: tsx src/index.ts rehearsal ${capturePath}`]);
    screen.redraw();
  }, REDRAW_TICK_MS);

  const keyboard = startKeyboard({
    onKey: () => {},
    onQuit: () => {
      child.kill('SIGTERM');
    },
  });

  const exitCode: number = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
  });

  clearInterval(tickTimer);
  tailer.stop();
  keyboard.stop();
  screen.setFooter([
    `run complete (exit ${exitCode}).`,
    stderrTail.trim() ? `agent stderr (tail): ${stderrTail.trim().slice(-300)}` : '',
    `capture saved: ${capturePath}`,
    `press ctrl-c to exit, or run: pnpm --filter @assay/demo exec tsx src/index.ts rehearsal ${capturePath}`,
  ].filter(Boolean));
  screen.redraw();

  return { exitCode, capturePath };
}

/** Picks the most recently modified `.scenic.ndjson` file under `apps/demo/captures/`, or undefined if none exist. */
export function findLatestCapture(): string | undefined {
  if (!existsSync(CAPTURES_DIR)) return undefined;
  const files = readdirSync(CAPTURES_DIR)
    .filter((name) => name.endsWith('.scenic.ndjson'))
    .map((name) => path.join(CAPTURES_DIR, name));
  if (files.length === 0) return undefined;
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/**
 * Replays a captured `.scenic.ndjson` file at the same pace it was recorded,
 * through the exact same parsing/mapping/framing pipeline `runScenicLive`
 * uses live -- declared as a replay on screen throughout (the HUD's `replay:
 * true`), never presented as if it were a live run.
 */
export async function runScenicRehearsal(capturePath: string, opts: ScenicRunOptions = {}): Promise<void> {
  const records: ScenicRecord[] = readScenicCapture(capturePath);
  const runLabel = path.basename(capturePath).replace(/\.scenic\.ndjson$/, '');
  const startedAt = Date.now();
  const screen = new ScenicScreen({ writer: opts.writer, replay: true, runLabel, startedAt, totalWidth: opts.totalWidth });
  const transcript = createAgentTranscript();
  const loopMapper = createScenicLoopMapper();
  let turns = 0;

  screen.setFooter([`REPLAY of ${capturePath} — declared, not a live run.`]);
  screen.redraw();

  const tickTimer = setInterval(() => {
    screen.setFooter([`REPLAY of ${capturePath} — declared, not a live run.  agent: turn ${turns}`]);
    screen.redraw();
  }, REDRAW_TICK_MS);

  await replayScenicCapture(records, (record) => {
    if (record.source === 'agent') {
      const paneLines = transcript.handleLine(record.payload);
      for (const line of paneLines) {
        if (line.kind === 'tool-call') turns += 1;
        screen.pushAgentLine(line);
      }
    } else {
      const parsed = parseSinkLine(record.payload);
      const { events, isRealLoopEvent } = loopMapper(parsed);
      screen.applyLoopEvents(events, isRealLoopEvent);
    }
    screen.redraw();
  });

  clearInterval(tickTimer);
  screen.setFooter([`REPLAY of ${capturePath} complete.`]);
  screen.redraw();
}

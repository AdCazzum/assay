/**
 * Renders a `LoopState` (or the `LoopEvent` sequence that produced it) to a
 * plain string. Pure by construction: no I/O, no clock, no clearing the
 * screen, that lives in `sink.ts`. This is what issue #30 asks to test as
 * "a pure function of the event sequence".
 *
 * Plain ANSI only (color codes are just escape sequences, not a dependency);
 * `color: false` turns them off, which is what makes the output pasteable
 * into a PR description or a test assertion.
 */

import { reduceEvents, STEP_LABEL, STEP_ORDER } from './events.js';
import type { Artifact, LoopEvent, LoopState, StepId, StepStatus } from './events.js';

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  redBg: '\x1b[41m\x1b[97m\x1b[1m',
} as const;

export type RenderOptions = {
  /** Whether to emit ANSI color/weight codes. Defaults to `true`; pass `false` for pasteable plain text. */
  color?: boolean;
  /** Header line printed above the steps. Defaults to a fixed title so fixture output is stable. */
  title?: string;
};

const STATUS_SYMBOL: Readonly<Record<StepStatus, string>> = {
  pending: '○',
  running: '◐',
  ok: '✔',
  failed: '✘',
};

function paint(color: boolean, code: string, text: string): string {
  return color ? `${code}${text}${ANSI.reset}` : text;
}

function statusColorCode(status: StepStatus): string {
  switch (status) {
    case 'pending':
      return ANSI.dim;
    case 'running':
      return ANSI.yellow;
    case 'ok':
      return ANSI.green;
    case 'failed':
      return ANSI.red;
  }
}

function renderArtifact(color: boolean, artifact: Artifact): string {
  const line = `      ${artifact.label}: ${artifact.value}`;
  return color ? paint(color, ANSI.dim, line) : line;
}

/**
 * The slash step gets deliberate extra visual weight when it lands `ok`:
 * issue #30 calls it the climax ("the bond moves, the score drops"), so it
 * is the one step whose `ok` state gets a banner instead of just a green
 * checkmark, both with and without color.
 */
function renderSlashBanner(color: boolean): string {
  const text = '  ██  BOND SLASHED  ██';
  return color ? paint(color, ANSI.redBg, text) : `  >>> BOND SLASHED <<<`;
}

function renderStep(step: StepId, color: boolean, state: LoopState[StepId]): string[] {
  const { status, summary, artifacts } = state;
  const symbol = paint(color, statusColorCode(status), STATUS_SYMBOL[status]);
  const label = paint(color, ANSI.bold, STEP_LABEL[step].padEnd(10));
  const body = summary ?? (status === 'pending' ? '(pending)' : '');
  const lines = [`[${symbol}] ${label} ${body}`];

  if (step === 'slash' && status === 'ok') {
    lines.push(renderSlashBanner(color));
  }

  for (const artifact of artifacts ?? []) {
    lines.push(renderArtifact(color, artifact));
  }

  return lines;
}

/** Renders a `LoopState` (an already-folded snapshot) to a plain string. */
export function renderState(state: LoopState, opts: RenderOptions = {}): string {
  const color = opts.color ?? true;
  const title = opts.title ?? 'ASSAY — reputation + payment rail';
  const lines = [paint(color, ANSI.bold, title), ''];

  for (const step of STEP_ORDER) {
    lines.push(...renderStep(step, color, state[step]));
  }

  return lines.join('\n');
}

/**
 * Renders a `LoopEvent` sequence directly: folds it with `reduceEvents` and
 * hands the result to `renderState`. The main entry point for tests and for
 * fixture-based rehearsal (`sink.ts`).
 */
export function render(events: readonly LoopEvent[], opts: RenderOptions = {}): string {
  return renderState(reduceEvents(events), opts);
}

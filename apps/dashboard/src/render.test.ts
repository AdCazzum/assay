import { describe, expect, it } from 'vitest';
import { render } from './render.js';
import { reduceEvents, STEP_LABEL, STEP_ORDER } from './events.js';
import type { LoopEvent } from './events.js';
import { renderState } from './render.js';
import { HAPPY_PATH_EVENTS } from './fixtures/happy-path.js';
import { SLASH_EVENTS } from './fixtures/slash.js';

describe('render (happy path)', () => {
  const output = render(HAPPY_PATH_EVENTS, { color: false });

  it('lists every step label, in the fixed loop order', () => {
    const lines = output.split('\n');
    let lastIndex = -1;
    for (const step of STEP_ORDER) {
      const index = lines.findIndex((line) => line.includes(STEP_LABEL[step]));
      expect(index, `${step} should appear`).toBeGreaterThan(-1);
      expect(index, `${step} should come after the previous step`).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it('marks steps the sequence never reaches as pending', () => {
    for (const step of ['challenge', 'verify', 'slash', 'reputation'] as const) {
      expect(output).toContain(`[○] ${STEP_LABEL[step].padEnd(10)} (pending)`);
    }
  });

  it('marks steps the sequence completed as ok, and register (an operator action outside this loop, see reset-demo-state.ts) as pending', () => {
    expect(output).toContain(`[○] ${STEP_LABEL.register.padEnd(10)} (pending)`);
    expect(output).toContain('[✔] Discover');
    expect(output).toContain('[✔] Pay');
    expect(output).toContain('[✔] Serve');
    expect(output).toContain('[✔] Accept');
  });

  it('renders real artifacts: tx ids, block numbers, claim values, straight from a live capture (apps/demo/scripts/capture-fixtures.ts)', () => {
    const payOk = HAPPY_PATH_EVENTS.find((e) => e.step === 'pay' && e.status === 'ok');
    const serveOk = HAPPY_PATH_EVENTS.find((e) => e.step === 'serve' && e.status === 'ok');
    const txArtifact = payOk?.artifacts?.find((a) => a.label === 'tx');
    const blockArtifact = serveOk?.artifacts?.find((a) => a.label === 'atBlock');
    const claimArtifact = serveOk?.artifacts?.find((a) => a.label === 'claim liquidityUsd');

    expect(txArtifact).toBeDefined();
    expect(blockArtifact).toBeDefined();
    expect(claimArtifact).toBeDefined();
    expect(output).toContain(`tx: ${txArtifact!.value}`);
    expect(output).toContain(`atBlock: ${blockArtifact!.value}`);
    expect(output).toContain(`claim liquidityUsd: ${claimArtifact!.value}`);
  });

  it('never emits color codes when color: false', () => {
    expect(output).not.toContain('\x1b[');
  });

  it('does emit ANSI codes by default', () => {
    const colored = render(HAPPY_PATH_EVENTS);
    expect(colored).toContain('\x1b[');
  });
});

describe('render (slash sequence, the climax)', () => {
  const output = render(SLASH_EVENTS, { color: false });

  it('gives the slash step a visually distinct banner beyond a checkmark', () => {
    expect(output).toContain('[✔] Slash');
    expect(output).toContain('BOND SLASHED');
  });

  it('shows the verifier verdict as FALSE, naming the claim that failed', () => {
    const verifyOk = SLASH_EVENTS.find((e) => e.step === 'verify' && e.status === 'ok');
    expect(output).toContain('verdict: FALSE');
    expect(verifyOk?.summary).toContain('liquidityUsd');
    // The claimed value always reads far larger than what The Graph actually
    // reports at the same block — that gap is the whole point of the climax.
    const reason = verifyOk?.artifacts?.find((a) => a.label === 'reason')?.value ?? '';
    const claimed = Number(reason.match(/liquidityUsd=([\d.]+)/)?.[1]);
    const actual = Number(reason.match(/reports ([\d.]+)/)?.[1]);
    expect(claimed).toBeGreaterThan(actual);
  });

  it('shows the reputation drop before/after, straight from the live capture', () => {
    const repOk = SLASH_EVENTS.find((e) => e.step === 'reputation' && e.status === 'ok');
    const scoreDelta = repOk?.artifacts?.find((a) => a.label === 'score')?.value ?? '';
    const slashesDelta = repOk?.artifacts?.find((a) => a.label === 'slashes')?.value ?? '';
    expect(output).toContain(`score: ${scoreDelta}`);
    expect(output).toContain(`slashes: ${slashesDelta}`);
    // A slash always drops the score and raises the slash count.
    const [before, after] = scoreDelta.split(' -> ').map(Number);
    expect(after).toBeLessThan(before);
    const [slashesBefore, slashesAfter] = slashesDelta.split(' -> ').map(Number);
    expect(slashesAfter).toBeGreaterThan(slashesBefore);
  });

  it('labels the lying provider honestly as a declared test harness', () => {
    expect(output).toContain('LYING PROVIDER, declared test harness');
  });

  it('the reputation step passes through a genuine in-flight state, not straight from pending to ok', () => {
    // Fold up to (and including) the last "still mining" heartbeat tick,
    // before the final `ok` event: this is the real #53 window where the
    // ENS write is still mining, one heartbeat of it captured live.
    let lastMiningIndex = -1;
    for (let i = 0; i < SLASH_EVENTS.length; i++) {
      if (SLASH_EVENTS[i].step === 'reputation' && SLASH_EVENTS[i].summary.includes('still mining')) lastMiningIndex = i;
    }
    expect(lastMiningIndex).toBeGreaterThan(-1);
    const midFlight = renderState(reduceEvents(SLASH_EVENTS.slice(0, lastMiningIndex + 1)), { color: false });

    // Distinct from pending (not "(pending)") and distinct from the final ok
    // line, with a heartbeat-style message a viewer can watch tick forward.
    expect(midFlight).toContain(`[◐] ${STEP_LABEL.reputation.padEnd(10)}`);
    expect(midFlight).not.toContain(`[○] ${STEP_LABEL.reputation.padEnd(10)} (pending)`);
    expect(midFlight).toContain('still mining');
  });
});

describe('render (failure degrades visibly, not a frozen screen)', () => {
  it('renders a failed step with its own symbol and message, and leaves later steps pending', () => {
    const events: LoopEvent[] = [
      { step: 'register', status: 'ok', summary: 'registered' },
      { step: 'discover', status: 'ok', summary: 'discovered' },
      { step: 'pay', status: 'failed', summary: 'mirror node timed out after 15s' },
    ];

    const output = render(events, { color: false });

    expect(output).toContain(`[✘] ${STEP_LABEL.pay.padEnd(10)} mirror node timed out after 15s`);
    expect(output).toContain(`[○] ${STEP_LABEL.serve.padEnd(10)} (pending)`);
  });

  it('renders a running step distinctly from pending and ok', () => {
    const events: LoopEvent[] = [{ step: 'pay', status: 'running', summary: 'paying 5 HBAR...' }];
    const output = render(events, { color: false });
    expect(output).toContain(`[◐] ${STEP_LABEL.pay.padEnd(10)} paying 5 HBAR...`);
  });
});

describe('render (empty sequence)', () => {
  it('renders every step pending, never an empty or broken screen', () => {
    const output = render([], { color: false });
    for (const step of STEP_ORDER) {
      expect(output).toContain(STEP_LABEL[step]);
    }
    expect(output).toContain('(pending)');
    expect(output.split('\n').length).toBeGreaterThan(STEP_ORDER.length);
  });
});

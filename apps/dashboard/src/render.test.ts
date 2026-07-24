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

  it('marks steps the sequence completed as ok', () => {
    expect(output).toContain('[✔] Register');
    expect(output).toContain('[✔] Discover');
    expect(output).toContain('[✔] Pay');
    expect(output).toContain('[✔] Serve');
    expect(output).toContain('[✔] Accept');
  });

  it('renders real artifacts: tx ids, hashscan links, block numbers, claim values', () => {
    expect(output).toContain('0.0.1234567@1784930210.111222333');
    expect(output).toContain('https://hashscan.io/testnet/transaction/');
    expect(output).toContain('atBlock: 22984210');
    expect(output).toContain('claim liquidityUsd: 361202208');
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

  it('shows the verifier verdict as FALSE, with both the claimed and actual value', () => {
    expect(output).toContain('verdict: FALSE');
    expect(output).toContain('liquidityUsd = 1000056.51');
    expect(output).toContain('liquidityUsd = 56.51');
    expect(output).toContain('claimed liquidityUsd=1000056.51 at block 22985614, but The Graph reports 56.51');
  });

  it('shows the reputation drop before/after', () => {
    expect(output).toContain('score: 92 -> 41 (-51)');
    expect(output).toContain('slashes: 0 -> 1');
  });

  it('labels the lying provider honestly as a declared test harness', () => {
    expect(output).toContain('LYING PROVIDER, declared test harness');
  });

  it('the reputation step passes through a genuine in-flight state, not straight from pending to ok', () => {
    // Fold only up to (but excluding) the final `ok` reputation event: this
    // is the ~12.5s window (#53) where the real ENS write is still mining.
    const okIndex = SLASH_EVENTS.findIndex((e) => e.step === 'reputation' && e.status === 'ok');
    const midFlight = renderState(reduceEvents(SLASH_EVENTS.slice(0, okIndex)), { color: false });

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

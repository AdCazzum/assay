import { describe, expect, it } from 'vitest';
import { initialLoopState, applyEvent } from '@assay/dashboard';
import { composeSceneFrame } from './scenic-frame.js';

describe('composeSceneFrame', () => {
  it('includes the HUD, both column headers, and a footer', () => {
    const frame = composeSceneFrame({
      hud: { elapsedMs: 1000, replay: false, runLabel: 'abc' },
      agentLines: ['▸ hello'],
      loopState: initialLoopState(),
      footerLines: ['ctrl-c aborts'],
      totalWidth: 80,
    });
    expect(frame).toContain('ASSAY — scenic run abc');
    expect(frame).toContain('AGENT (claude, live reasoning)');
    expect(frame).toContain('LOOP (assay node');
    expect(frame).toContain('▸ hello');
    expect(frame).toContain('ctrl-c aborts');
  });

  it('renders every loop step, even pending ones, matching @assay/dashboard\'s own contract', () => {
    const frame = composeSceneFrame({
      hud: { elapsedMs: 0, replay: false, runLabel: 'x' },
      agentLines: [],
      loopState: initialLoopState(),
      footerLines: [],
      totalWidth: 80,
    });
    expect(frame).toContain('Register');
    expect(frame).toContain('Reputation');
  });

  it('reflects a folded event in the loop pane (e.g. discover ok)', () => {
    const state = applyEvent(initialLoopState(), { step: 'discover', status: 'ok', summary: 'resolved rugscore.assay.eth' });
    const frame = composeSceneFrame({
      hud: { elapsedMs: 0, replay: false, runLabel: 'x' },
      agentLines: [],
      loopState: state,
      footerLines: [],
      totalWidth: 200,
    });
    expect(frame).toContain('resolved rugscore.assay.eth');
  });

  it('omits the footer block entirely when there are no footer lines', () => {
    const frame = composeSceneFrame({
      hud: { elapsedMs: 0, replay: false, runLabel: 'x' },
      agentLines: [],
      loopState: initialLoopState(),
      footerLines: [],
      totalWidth: 80,
    });
    expect(frame.endsWith('\n')).toBe(false);
  });
});

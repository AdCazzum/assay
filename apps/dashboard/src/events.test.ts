import { describe, expect, it } from 'vitest';
import { applyEvent, initialLoopState, reduceEvents, STEP_ORDER } from './events.js';
import type { LoopEvent } from './events.js';

describe('initialLoopState', () => {
  it('starts every step pending with no summary or artifacts', () => {
    const state = initialLoopState();
    for (const step of STEP_ORDER) {
      expect(state[step]).toEqual({ status: 'pending' });
    }
  });
});

describe('applyEvent', () => {
  it('sets the named step and leaves every other step untouched', () => {
    const before = initialLoopState();
    const event: LoopEvent = { step: 'pay', status: 'ok', summary: 'paid' };

    const after = applyEvent(before, event);

    expect(after.pay).toEqual({ status: 'ok', summary: 'paid', artifacts: undefined });
    for (const step of STEP_ORDER) {
      if (step !== 'pay') {
        expect(after[step]).toEqual(before[step]);
      }
    }
  });

  it('does not mutate the state passed in', () => {
    const before = initialLoopState();
    applyEvent(before, { step: 'register', status: 'ok', summary: 'done' });
    expect(before.register).toEqual({ status: 'pending' });
  });

  it('a later event for the same step replaces the earlier one wholesale', () => {
    const running: LoopEvent = { step: 'verify', status: 'running', summary: 'checking...' };
    const ok: LoopEvent = {
      step: 'verify',
      status: 'ok',
      summary: 'verdict: FALSE',
      artifacts: [{ label: 'claimed', value: 'false' }],
    };

    const state = reduceEvents([running, ok]);

    expect(state.verify).toEqual({
      status: 'ok',
      summary: 'verdict: FALSE',
      artifacts: [{ label: 'claimed', value: 'false' }],
    });
  });
});

describe('reduceEvents', () => {
  it('folds an empty sequence to the initial state', () => {
    expect(reduceEvents([])).toEqual(initialLoopState());
  });

  it('folds a sequence step by step, matching repeated applyEvent calls', () => {
    const events: LoopEvent[] = [
      { step: 'register', status: 'ok', summary: 'registered' },
      { step: 'discover', status: 'ok', summary: 'discovered' },
      { step: 'pay', status: 'failed', summary: 'timed out' },
    ];

    const viaReduce = reduceEvents(events);
    const viaFold = events.reduce(applyEvent, initialLoopState());

    expect(viaReduce).toEqual(viaFold);
    expect(viaReduce.pay.status).toBe('failed');
    expect(viaReduce.serve).toEqual({ status: 'pending' });
  });
});

import { describe, expect, it } from 'vitest';
import { createStepMachine, STEP_ORDER, type StepRunners } from './step-machine.js';

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function buildDeferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createStepMachine', () => {
  it('starts on discover, running false', () => {
    const machine = createStepMachine(() => ({
      discover: async () => {},
      pay: async () => {},
      serve: async () => {},
      challenge: async () => {},
    }));
    expect(machine.state()).toEqual({ next: 'discover', running: false });
  });

  it('advances only in STEP_ORDER, only when the runner calls advance()', async () => {
    const statuses: string[] = [];
    const machine = createStepMachine(
      (ctx): StepRunners => ({
        discover: async () => ctx.advance('discover'),
        pay: async () => ctx.advance('pay'),
        serve: async () => ctx.advance('serve'),
        challenge: async () => ctx.advance('challenge'),
      }),
      (msg) => statuses.push(msg),
    );

    for (const [i, key] of ['1', '2', '3', '4'].entries()) {
      machine.handleKey(key);
      await flush();
      expect(machine.state().next).toBe(i + 1 < STEP_ORDER.length ? STEP_ORDER[i + 1] : 'done');
    }
    expect(statuses.at(-1)).toContain('demo complete');
  });

  it('a runner that resolves without calling advance() does not move next', async () => {
    const machine = createStepMachine(() => ({
      discover: async () => {}, // never calls ctx.advance
      pay: async () => {},
      serve: async () => {},
      challenge: async () => {},
    }));
    machine.handleKey('1');
    await flush();
    expect(machine.state().next).toBe('discover');
  });

  it('a runner that throws is caught centrally, reported via onStatus, and does not advance', async () => {
    const statuses: string[] = [];
    const machine = createStepMachine(
      () => ({
        discover: async () => {
          throw new Error('boom');
        },
        pay: async () => {},
        serve: async () => {},
        challenge: async () => {},
      }),
      (msg) => statuses.push(msg),
    );
    machine.handleKey('1');
    await flush();
    expect(machine.state().next).toBe('discover');
    expect(machine.state().running).toBe(false);
    expect(statuses.some((s) => s.includes('boom'))).toBe(true);
  });

  it('rejects a key pressed out of order without running it', async () => {
    let payRan = false;
    const machine = createStepMachine(() => ({
      discover: async () => {},
      pay: async () => {
        payRan = true;
      },
      serve: async () => {},
      challenge: async () => {},
    }));
    machine.handleKey('2');
    await flush();
    expect(payRan).toBe(false);
    expect(machine.state().next).toBe('discover');
  });

  it('a stray keypress while running is ignored, not queued', async () => {
    const deferred = buildDeferred();
    let callCount = 0;
    const machine = createStepMachine((ctx): StepRunners => ({
      discover: async () => {
        callCount += 1;
        await deferred.promise;
        ctx.advance('discover');
      },
      pay: async () => {},
      serve: async () => {},
      challenge: async () => {},
    }));

    machine.handleKey('1');
    expect(machine.state().running).toBe(true);
    machine.handleKey('1'); // stray re-press mid-flight
    machine.handleKey('1');

    deferred.resolve();
    await flush();

    expect(callCount).toBe(1);
    expect(machine.state().next).toBe('pay');
  });

  it('ignores unknown keys entirely', () => {
    const machine = createStepMachine(() => ({
      discover: async () => {},
      pay: async () => {},
      serve: async () => {},
      challenge: async () => {},
    }));
    machine.handleKey('9');
    machine.handleKey('');
    expect(machine.state()).toEqual({ next: 'discover', running: false });
  });
});

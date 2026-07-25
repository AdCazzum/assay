/**
 * Unit tests for the two pure helpers `events.ts` exports on top of the
 * `LoopEvent` type itself (issue #83). The rest of the event vocabulary is
 * exercised end to end through `createAssayNode` in `node.test.ts` -- there
 * is no separate value to unit-testing a type union in isolation.
 */

import { describe, expect, it } from 'vitest';
import { assertUnreachableEvent, createEventStamper, type LoopEvent } from './events.js';

describe('createEventStamper', () => {
  it('stamps a monotonically increasing seq starting at 1, scoped to this stamper instance', () => {
    const stamp = createEventStamper();

    const first = stamp({ step: 'discover', outcome: 'ok', name: 'a.assay.eth', provider: {} as never });
    const second = stamp({ step: 'discover', outcome: 'ok', name: 'b.assay.eth', provider: {} as never });
    const third = stamp({ step: 'discover', outcome: 'ok', name: 'c.assay.eth', provider: {} as never });

    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
  });

  it('stamps a real Date.now()-based `at`, not a fixed or zero value', () => {
    const stamp = createEventStamper();
    const before = Date.now();
    const event = stamp({ step: 'discover', outcome: 'ok', name: 'a.assay.eth', provider: {} as never });
    const after = Date.now();

    expect(event.at).toBeGreaterThanOrEqual(before);
    expect(event.at).toBeLessThanOrEqual(after);
  });

  it('two independently-constructed stampers do not share a counter: each starts fresh at 1', () => {
    const stampA = createEventStamper();
    const stampB = createEventStamper();

    stampA({ step: 'discover', outcome: 'ok', name: 'a.assay.eth', provider: {} as never });
    const fromA = stampA({ step: 'discover', outcome: 'ok', name: 'a.assay.eth', provider: {} as never });
    const fromB = stampB({ step: 'discover', outcome: 'ok', name: 'b.assay.eth', provider: {} as never });

    expect(fromA.seq).toBe(2);
    expect(fromB.seq).toBe(1); // not 3 -- a fresh stamper does not inherit stampA's count
  });

  it('preserves every field of the body passed in, alongside the stamped at/seq', () => {
    const stamp = createEventStamper();
    const event = stamp({ step: 'challenge', phase: 'started', jobId: 'job-1', claimKey: 'someClaim' });

    expect(event).toMatchObject({ step: 'challenge', phase: 'started', jobId: 'job-1', claimKey: 'someClaim' });
    expect(typeof event.at).toBe('number');
    expect(typeof event.seq).toBe('number');
  });
});

describe('assertUnreachableEvent', () => {
  it('throws, naming the unexpected variant, when reached at runtime', () => {
    // Simulates a `switch (event.step)` whose `default` branch was reached
    // because a variant was added/renamed without updating the switch --
    // exactly the bug this helper exists to force a compile error for
    // instead of a silent runtime fallthrough.
    const unexpected = { step: 'not-a-real-step' } as unknown as never;
    expect(() => assertUnreachableEvent(unexpected)).toThrow(/Unreachable LoopEvent/);
  });

  it("compiles as an exhaustive switch's default branch over the real LoopEvent union (type-level check)", () => {
    function describeStep(event: LoopEvent): string {
      switch (event.step) {
        case 'register':
          return 'register';
        case 'discover':
          return 'discover';
        case 'pay':
          return 'pay';
        case 'serve':
          return 'serve';
        case 'accept':
          return 'accept';
        case 'challenge':
          return 'challenge';
        case 'verify':
          return 'verify';
        case 'slash':
        case 'reputation':
          return 'settlement';
        default:
          return assertUnreachableEvent(event);
      }
    }

    // Not exercising every branch here (node.test.ts does that end to end);
    // this test's real payload is that the file above typechecks at all --
    // if a LoopEvent variant were added without a matching case, `event` in
    // the `default` branch would stop being typed `never` and `tsc` would
    // fail this file.
    expect(
      describeStep({ at: 1, seq: 1, step: 'accept', job: {} as never }),
    ).toBe('accept');
  });
});

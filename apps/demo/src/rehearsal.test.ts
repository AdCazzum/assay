import { describe, expect, it } from 'vitest';
import type { LoopEvent } from '@assay/dashboard';
import type { DemoStepId } from './step-machine.js';
import { createRehearsalSession } from './rehearsal.js';

/** A tiny fraction of the real demo pacing (`STEP_TARGET_MS` in `rehearsal.ts`), so these tests exercise the same pacing/guard code path without waiting through the real ~45s worst case. */
const FAST_PACE: Readonly<Record<DemoStepId, number>> = { discover: 5, pay: 10, serve: 10, challenge: 40 };

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntilNext(session: ReturnType<typeof createRehearsalSession>, target: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (session.state().next !== target) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for next="${target}"`);
    await flush();
  }
}

describe('createRehearsalSession', () => {
  it('replays the same four keys, in the same order, with no network', async () => {
    const events: LoopEvent[] = [];
    const session = createRehearsalSession({ push: (e) => events.push(e), stepTargetMs: FAST_PACE });

    session.handleKey('1');
    await waitUntilNext(session, 'pay');
    expect(events.some((e) => e.step === 'discover' && e.status === 'ok')).toBe(true);

    session.handleKey('2');
    await waitUntilNext(session, 'serve');
    expect(events.some((e) => e.step === 'pay' && e.status === 'ok')).toBe(true);

    session.handleKey('3');
    await waitUntilNext(session, 'challenge');
    expect(events.some((e) => e.step === 'serve' && e.status === 'ok')).toBe(true);
    expect(events.some((e) => e.step === 'accept')).toBe(true);
  });

  it('the challenge replay never includes the sacrificial provider\'s own discover/pay/serve/accept preamble', async () => {
    const events: LoopEvent[] = [];
    const session = createRehearsalSession({ push: (e) => events.push(e), stepTargetMs: FAST_PACE });
    session.handleKey('1');
    await waitUntilNext(session, 'pay');
    session.handleKey('2');
    await waitUntilNext(session, 'serve');
    session.handleKey('3');
    await waitUntilNext(session, 'challenge');

    const beforeChallenge = events.length;
    session.handleKey('4');
    await waitUntilNext(session, 'done');

    const climax = events.slice(beforeChallenge);
    const steps = new Set(climax.map((e) => e.step));
    expect(steps.has('discover')).toBe(false);
    expect(steps.has('pay')).toBe(false);
    expect(steps.has('serve')).toBe(false);
    expect(steps.has('accept')).toBe(false);
    expect(steps.has('challenge')).toBe(true);
    expect(steps.has('verify')).toBe(true);
    expect(steps.has('slash')).toBe(true);
    expect(steps.has('reputation')).toBe(true);
  });

  it('guards against restarting a running (paced) step', async () => {
    const events: LoopEvent[] = [];
    const statuses: string[] = [];
    const session = createRehearsalSession({ push: (e) => events.push(e), onStatus: (m) => statuses.push(m), stepTargetMs: FAST_PACE });

    session.handleKey('1');
    expect(session.state().running).toBe(true);
    session.handleKey('1'); // stray re-press
    await waitUntilNext(session, 'pay');

    expect(statuses.some((s) => s.includes('still working on'))).toBe(true);
    // Exactly one discover 'ok' — a restart would have produced two.
    expect(events.filter((e) => e.step === 'discover' && e.status === 'ok')).toHaveLength(1);
  });
});

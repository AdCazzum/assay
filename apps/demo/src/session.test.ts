import { describe, expect, it } from 'vitest';
import { createAssayNode, createCapabilityRegistry, type Manifest } from '@assay/core';
import { createCoreEventMapper, type LoopEvent } from '@assay/dashboard';
import { createRugScoreCapability, createLyingRugScoreProvider, CLEAN_TOKEN_SIGNALS, RUG_TOKEN_SIGNALS } from '@assay/cap-rugscore';
import { FakeGraphPort, FakePaymentsPort, FakeRegistryPort } from './fakes.js';
import { createDemoSession, DEFAULT_LIAR_TOKEN, DEFAULT_REQUEST_TOKEN } from './session.js';

const GOOD_NAME = 'rugscore.assay.eth';
const LIAR_NAME = 'liar.assay.eth';
const AT_BLOCK = 22_000_000;
const CHALLENGER_ACCOUNT_ID = '0.0.999999';

const goodManifest: Manifest = {
  capabilityId: 'rugscore',
  description: 'rug-pull risk',
  priceHbar: 5,
  endpoint: 'https://example.invalid/serve',
  bondRef: 'bond-good',
  verifierHash: '0xseed',
};

const liarManifest: Manifest = { ...goodManifest, bondRef: 'bond-liar' };

function buildHarness(opts: { goodReputation?: { score: number; jobs: number; slashes: number; bondHbar: number }; paymentsDelayMs?: number } = {}) {
  const registry = new FakeRegistryPort()
    .seed(GOOD_NAME, {
      manifest: goodManifest,
      reputation: opts.goodReputation ?? { score: 78, jobs: 14, slashes: 0, bondHbar: 30 },
    })
    .seed(LIAR_NAME, { manifest: liarManifest, reputation: { score: 88, jobs: 9, slashes: 1, bondHbar: 30 } });

  const payments = new FakePaymentsPort({ delayMs: opts.paymentsDelayMs });
  const graph = new FakeGraphPort(AT_BLOCK, {
    [DEFAULT_REQUEST_TOKEN]: { ...CLEAN_TOKEN_SIGNALS, atBlock: AT_BLOCK },
    [DEFAULT_LIAR_TOKEN]: { ...RUG_TOKEN_SIGNALS, atBlock: AT_BLOCK },
  });

  const honestCapabilities = createCapabilityRegistry();
  honestCapabilities.register(createRugScoreCapability({ graph }));
  const lyingCapabilities = createCapabilityRegistry();
  lyingCapabilities.register(createLyingRugScoreProvider({ graph }));

  const events: LoopEvent[] = [];
  const requesterMapper = createCoreEventMapper();
  const challengeMapper = createCoreEventMapper();
  const CHALLENGE_VISIBLE = new Set(['challenge', 'verify', 'slash', 'reputation']);
  // Same `onPayFinalizing` wiring `main.ts` does (see session.ts's module doc
  // comment): without it, serve()'s own payment re-verification would
  // downgrade the pay row this harness's own doPay already reported in full.
  let suppressPayEvents = false;

  const requesterNode = createAssayNode({
    registry,
    payments,
    graph,
    capabilities: honestCapabilities,
    challengerAccountId: CHALLENGER_ACCOUNT_ID,
    onLoopEvent: (e) => {
      for (const m of requesterMapper(e)) {
        if (m.step === 'pay' && suppressPayEvents) continue;
        events.push(m);
      }
    },
  });
  const challengeNode = createAssayNode({
    registry,
    payments,
    graph,
    capabilities: lyingCapabilities,
    challengerAccountId: CHALLENGER_ACCOUNT_ID,
    onLoopEvent: (e) => {
      for (const m of challengeMapper(e)) if (CHALLENGE_VISIBLE.has(m.step)) events.push(m);
    },
  });

  const statuses: string[] = [];
  const session = createDemoSession({
    requesterNode,
    challengeNode,
    registry,
    payments,
    goodProviderName: GOOD_NAME,
    liarProviderName: LIAR_NAME,
    push: (event) => events.push(event),
    onStatus: (msg) => statuses.push(msg),
    onPayFinalizing: () => {
      suppressPayEvents = true;
    },
  });

  return { session, events, statuses, registry, payments };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createDemoSession — sequencing', () => {
  it('ignores a key that is not the next expected step, without changing state', async () => {
    const { session, events, statuses } = buildHarness();

    session.handleKey('2'); // pay before discover
    await flush();

    expect(session.state().next).toBe('discover');
    expect(events).toHaveLength(0);
    expect(statuses.at(-1)).toContain('press 1 (discover) first');
  });

  it('ignores an unknown key silently', () => {
    const { session } = buildHarness();
    session.handleKey('x');
    expect(session.state().next).toBe('discover');
  });

  it('a running step cannot be restarted by a stray keypress', async () => {
    const { session, payments, statuses } = buildHarness({ paymentsDelayMs: 20 });
    session.handleKey('1');
    await flush();
    expect(session.state().next).toBe('pay');

    session.handleKey('2'); // starts the (slow) pay step
    expect(session.state().running).toBe(true);
    session.handleKey('2'); // stray re-press while running

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(payments.payCalls).toHaveLength(1); // only one real payment was made
    expect(statuses.some((s) => s.includes('still working on'))).toBe(true);
  });
});

describe('createDemoSession — discover/pay/serve (good provider)', () => {
  it('discover resolves the live record and advances to pay', async () => {
    const { session, events } = buildHarness();

    session.handleKey('1');
    await flush();

    expect(session.state().next).toBe('pay');
    const discoverEvent = events.find((e) => e.step === 'discover');
    expect(discoverEvent?.status).toBe('ok');
    expect(discoverEvent?.summary).toContain('5 HBAR');
  });

  it('pay makes a real payment and confirms it, advancing to serve', async () => {
    const { session, events, payments } = buildHarness();
    session.handleKey('1');
    await flush();

    session.handleKey('2');
    await flush();

    expect(session.state().next).toBe('serve');
    expect(payments.payCalls).toHaveLength(1);
    const payEvents = events.filter((e) => e.step === 'pay');
    expect(payEvents.at(-1)?.status).toBe('ok');
    expect(payEvents.at(-1)?.summary).toMatch(/confirmed via mirror node in \d/);
  });

  it('pay declines when the policy would decline, and does not advance', async () => {
    const { session, events, payments } = buildHarness({ goodReputation: { score: 10, jobs: 10, slashes: 5, bondHbar: 1 } });
    session.handleKey('1');
    await flush();

    session.handleKey('2');
    await flush();

    expect(session.state().next).toBe('pay'); // did not advance
    expect(payments.payCalls).toHaveLength(0); // never actually paid
    const payEvent = events.find((e) => e.step === 'pay');
    expect(payEvent?.status).toBe('failed');
    expect(payEvent?.summary).toContain('declining to pay');
  });

  it('serve does not downgrade the pay row: serve() re-verifies payment internally, but the rich "confirmed in Xs" narration survives', async () => {
    const { session, events } = buildHarness();
    session.handleKey('1');
    await flush();
    session.handleKey('2');
    await flush();

    const payAfterPay = events.filter((e) => e.step === 'pay').at(-1);
    expect(payAfterPay?.summary).toMatch(/confirmed via mirror node in \d/);

    session.handleKey('3');
    await flush();

    // serve() internally re-runs confirmPayment (SPEC.md §12), which would
    // otherwise re-emit a thinner 'pay' event through the wired mapper and
    // overwrite the row above with a bare "paid, confirmed via mirror node".
    const payEventsAfterServe = events.filter((e) => e.step === 'pay');
    expect(payEventsAfterServe.at(-1)?.summary).toMatch(/confirmed via mirror node in \d/);
    expect(payEventsAfterServe.at(-1)).toEqual(payAfterPay);
  });

  it('serve runs the real capability and advances to challenge, with claim artifacts', async () => {
    const { session, events } = buildHarness();
    session.handleKey('1');
    await flush();
    session.handleKey('2');
    await flush();

    session.handleKey('3');
    await flush();

    expect(session.state().next).toBe('challenge');
    const serveEvent = events.find((e) => e.step === 'serve');
    expect(serveEvent?.status).toBe('ok');
    expect(serveEvent?.artifacts?.some((a) => a.label.startsWith('claim '))).toBe(true);
    expect(events.find((e) => e.step === 'accept')?.status).toBe('ok');
  });

  it('serve refuses to run without a confirmed payment on hand', async () => {
    const { session, statuses } = buildHarness();
    session.handleKey('1');
    await flush();
    // skip pay — but guard() blocks key 3 anyway since next !== 'serve'
    session.handleKey('3');
    await flush();
    expect(statuses.at(-1)).toContain('press 2 (pay) first');
  });
});

describe('createDemoSession — challenge (lying provider climax)', () => {
  it('re-bonds and serves the sacrificial provider silently, then narrates only challenge/verify/slash/reputation', async () => {
    const { session, events } = buildHarness();
    session.handleKey('1');
    await flush();
    session.handleKey('2');
    await flush();
    session.handleKey('3');
    await flush();

    const beforeChallenge = events.length;
    session.handleKey('4');
    // Poll until settle() resolves — no fake timers needed since fakes have zero delay.
    for (let i = 0; i < 50 && session.state().next !== 'done'; i++) {
      await flush();
    }

    expect(session.state().next).toBe('done');
    const climaxEvents = events.slice(beforeChallenge);
    const stepsSeen = new Set(climaxEvents.map((e) => e.step));
    // The sacrificial provider's own discover/pay/serve/accept preamble must
    // never appear: only the climax steps do.
    expect(stepsSeen.has('discover')).toBe(false);
    expect(stepsSeen.has('pay')).toBe(false);
    expect(stepsSeen.has('serve')).toBe(false);
    expect(stepsSeen.has('accept')).toBe(false);
    expect(stepsSeen.has('challenge')).toBe(true);
    expect(stepsSeen.has('verify')).toBe(true);
    expect(stepsSeen.has('slash')).toBe(true);
    expect(stepsSeen.has('reputation')).toBe(true);

    const verifyEvent = climaxEvents.find((e) => e.step === 'verify');
    expect(verifyEvent?.summary).toContain('FALSE');
    const slashEvent = climaxEvents.find((e) => e.step === 'slash' && e.status === 'ok');
    expect(slashEvent).toBeDefined();
  });

  it('pushes a synthetic "preparing" event immediately, before any network call resolves', async () => {
    const { session, events } = buildHarness({ paymentsDelayMs: 10 });
    session.handleKey('1');
    await flush();
    session.handleKey('2');
    await new Promise((r) => setTimeout(r, 20));
    session.handleKey('3');
    await flush();

    session.handleKey('4');
    // Synchronous push happens before the first awaited network call.
    expect(events.at(-1)?.step).toBe('challenge');
    expect(events.at(-1)?.status).toBe('running');
    expect(events.at(-1)?.summary).toContain('preparing the challenge');

    for (let i = 0; i < 50 && session.state().next !== 'done'; i++) {
      await flush();
    }
  });
});

describe('createDemoSession — advance() status messaging', () => {
  it('announces the next key after every successful step', async () => {
    const { session, statuses } = buildHarness();
    session.handleKey('1');
    await flush();
    expect(statuses.at(-1)).toContain('press 2 (pay) next');
  });
});

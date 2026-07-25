import { describe, expect, it } from 'vitest';
import { createEventStamper } from '@assay/core';
import type { LoopEventVariant, ProviderRecord } from '@assay/core';
import { createCoreEventMapper, mapCoreEvent } from './from-core.js';

const PROVIDER: ProviderRecord = {
  name: 'rugscore.assay.eth',
  manifest: {
    capabilityId: 'rugscore',
    description: 'rug-pull risk',
    priceHbar: 5,
    endpoint: 'http://localhost:8787/serve',
    bondRef: 'bond-1',
    verifierHash: 'abc123',
  },
  reputation: { score: 78, jobs: 14, slashes: 0, bondHbar: 30 },
};

function stampAll(bodies: LoopEventVariant[]) {
  const stamp = createEventStamper();
  return bodies.map(stamp);
}

describe('mapCoreEvent — discover', () => {
  it('maps a successful resolution to an ok event with real artifacts', () => {
    const [event] = stampAll([{ step: 'discover', outcome: 'ok', name: PROVIDER.name, provider: PROVIDER }]);
    const [mapped] = mapCoreEvent(event);
    expect(mapped.step).toBe('discover');
    expect(mapped.status).toBe('ok');
    expect(mapped.summary).toContain('5 HBAR');
    expect(mapped.summary).toContain('score 78');
    expect(mapped.artifacts).toContainEqual({ label: 'ens name', value: 'rugscore.assay.eth' });
  });

  it('maps a failed resolution to a failed event, not a hang', () => {
    const [event] = stampAll([
      { step: 'discover', outcome: 'failed', name: 'ghost.assay.eth', error: new Error('no manifest') },
    ]);
    const [mapped] = mapCoreEvent(event);
    expect(mapped.status).toBe('failed');
    expect(mapped.summary).toContain('no manifest');
  });
});

describe('mapCoreEvent — pay', () => {
  it('renders a decline as failed, without ever reaching paid', () => {
    const assessment = {
      providerName: PROVIDER.name,
      priceHbar: 5,
      jobs: 10,
      slashes: 5,
      slashRatio: 0.5,
      unproven: false,
      bondHbar: 1,
      bondToPriceRatio: 0.2,
      score: 10,
      signals: [],
    };
    const [event] = stampAll([
      {
        step: 'pay',
        phase: 'assessed',
        name: PROVIDER.name,
        assessment,
        decision: { pay: false, reason: 'too risky', violations: [] },
      },
    ]);
    const [mapped] = mapCoreEvent(event);
    expect(mapped.status).toBe('failed');
    expect(mapped.summary).toContain('too risky');
  });

  it('computes real elapsed confirm time from paid -> confirmed, stateful across calls', async () => {
    const mapper = createCoreEventMapper();
    const stamp = createEventStamper();
    const paid = stamp({ step: 'pay', phase: 'paid', name: PROVIDER.name, txId: '0.0.1@1', amountHbar: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const confirmed = stamp({ step: 'pay', phase: 'confirmed', txId: '0.0.1@1' });

    mapper(paid);
    const [mapped] = mapper(confirmed);

    expect(mapped.status).toBe('ok');
    expect(mapped.summary).toMatch(/confirmed via mirror node in 0\.\ds/);
    expect(mapped.artifacts).toContainEqual({ label: 'tx', value: '0.0.1@1' });
  });

  it('renders not-confirmed as failed', () => {
    const [event] = stampAll([{ step: 'pay', phase: 'not-confirmed', txId: '0.0.1@1', reason: 'amount-too-low' }]);
    const [mapped] = mapCoreEvent(event);
    expect(mapped.status).toBe('failed');
    expect(mapped.summary).toContain('amount-too-low');
  });
});

describe('mapCoreEvent — serve/accept', () => {
  it('maps a served job to ok with claim artifacts', () => {
    const job = {
      jobId: 'job-1',
      provider: PROVIDER.name,
      capabilityId: 'rugscore',
      request: '0xTOKEN',
      paymentTx: '0.0.1@1',
      result: { score: 9 },
      claims: [{ k: 'liquidityUsd', v: 361202208, atBlock: 22984210 }],
      status: 'served' as const,
    };
    const [serveEvent, acceptEvent] = stampAll([
      { step: 'serve', outcome: 'ok', job },
      { step: 'accept', job },
    ]);
    const [mappedServe] = mapCoreEvent(serveEvent);
    const [mappedAccept] = mapCoreEvent(acceptEvent);

    expect(mappedServe.status).toBe('ok');
    expect(mappedServe.artifacts).toContainEqual({ label: 'claim liquidityUsd', value: '361202208' });
    expect(mappedServe.artifacts).toContainEqual({ label: 'atBlock', value: '22984210' });
    expect(mappedAccept.step).toBe('accept');
    expect(mappedAccept.status).toBe('ok');
  });

  it('maps a failed serve as failed, not a hang', () => {
    const [event] = stampAll([
      { step: 'serve', outcome: 'failed', provider: PROVIDER.name, capabilityId: 'rugscore', txId: '0.0.1@1', error: new Error('graph down') },
    ]);
    const [mapped] = mapCoreEvent(event);
    expect(mapped.status).toBe('failed');
    expect(mapped.summary).toContain('graph down');
  });
});

describe('mapCoreEvent — challenge/verify', () => {
  it('a committed verdict flips both challenge (ok) and verify (ok), FALSE verdict included', () => {
    const [started] = stampAll([{ step: 'challenge', phase: 'started', jobId: 'job-2', claimKey: 'liquidityUsd' }]);
    const [verified] = stampAll([
      {
        step: 'verify',
        jobId: 'job-2',
        claimKey: 'liquidityUsd',
        claims: [{ k: 'liquidityUsd', v: 1000056.51, atBlock: 22985614 }],
        verdict: { valid: false, badClaim: 'liquidityUsd', reason: 'The Graph reports 56.51' },
        committed: true,
      },
    ]);

    const [runningChallenge] = mapCoreEvent(started);
    expect(runningChallenge.step).toBe('challenge');
    expect(runningChallenge.status).toBe('running');

    const mapped = mapCoreEvent(verified);
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({ step: 'challenge', status: 'ok' });
    expect(mapped[1]).toMatchObject({ step: 'verify', status: 'ok' });
    expect(mapped[1].summary).toContain('FALSE');
  });

  it('a read-only verifyClaim (committed: false) only touches verify, not challenge', () => {
    const [event] = stampAll([
      {
        step: 'verify',
        jobId: 'job-3',
        claimKey: 'liquidityUsd',
        claims: [],
        verdict: { valid: true },
        committed: false,
      },
    ]);
    const mapped = mapCoreEvent(event);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].step).toBe('verify');
    expect(mapped[0].summary).toContain('VALID');
  });

  it('a challenge that fails to even reach a verdict renders as failed', () => {
    const [event] = stampAll([
      { step: 'challenge', phase: 'failed', jobId: 'job-2', claimKey: 'liquidityUsd', error: new Error('graph timeout') },
    ]);
    const [mapped] = mapCoreEvent(event);
    expect(mapped.step).toBe('challenge');
    expect(mapped.status).toBe('failed');
    expect(mapped.summary).toContain('graph timeout');
  });
});

describe('mapCoreEvent — settlement (slash + reputation tee separately, #53)', () => {
  const before = { score: 88, jobs: 9, slashes: 1, bondHbar: 30 };

  it('slashing/writing-reputation both render running immediately (concurrent legs)', () => {
    const [slashing] = stampAll([{ step: 'slash', progress: { phase: 'slashing', elapsedMs: 0 } }]);
    const [writing] = stampAll([{ step: 'reputation', progress: { phase: 'writing-reputation', elapsedMs: 0 }, before }]);

    const [mappedSlash] = mapCoreEvent(slashing);
    const [mappedRep] = mapCoreEvent(writing);

    expect(mappedSlash).toMatchObject({ step: 'slash', status: 'running' });
    expect(mappedRep).toMatchObject({ step: 'reputation', status: 'running' });
  });

  it('slash flips to ok in under a second while reputation is still running (the #53 property)', () => {
    const [slashConfirmed] = stampAll([
      { step: 'slash', progress: { phase: 'slash-confirmed', elapsedMs: 400, txId: '0.0.9695801@1' } },
    ]);
    const [mapped] = mapCoreEvent(slashConfirmed);
    expect(mapped).toMatchObject({ step: 'slash', status: 'ok' });
    expect(mapped.artifacts).toContainEqual({ label: 'tx', value: '0.0.9695801@1' });
  });

  it('reputation-confirmed renders the before -> after delta', () => {
    const [event] = stampAll([
      {
        step: 'reputation',
        progress: {
          phase: 'reputation-confirmed',
          elapsedMs: 12500,
          txHash: 'sepolia:0xabc',
          reputation: { score: 41, jobs: 9, slashes: 2, bondHbar: 30 },
        },
        before,
      },
    ]);
    const [mapped] = mapCoreEvent(event);
    expect(mapped.status).toBe('ok');
    expect(mapped.summary).toContain('12.5s');
    expect(mapped.artifacts).toContainEqual({ label: 'score', value: '88 -> 41' });
    expect(mapped.artifacts).toContainEqual({ label: 'slashes', value: '1 -> 2' });
  });

  it('slash-failed and reputation-failed both render failed, not a hang', () => {
    const [slashFailed] = stampAll([{ step: 'slash', progress: { phase: 'slash-failed', elapsedMs: 100 } }]);
    const [repFailed] = stampAll([{ step: 'reputation', progress: { phase: 'reputation-failed', elapsedMs: 100 }, before }]);
    expect(mapCoreEvent(slashFailed)[0].status).toBe('failed');
    expect(mapCoreEvent(repFailed)[0].status).toBe('failed');
  });

  it('the settle done tick carries nothing new (its own leg already reported it)', () => {
    const [event] = stampAll([{ step: 'reputation', progress: { phase: 'done', elapsedMs: 13000, job: {} as never } }]);
    expect(mapCoreEvent(event)).toHaveLength(0);
  });
});

describe('mapCoreEvent — register', () => {
  it('narrates each phase, landing ok with every real artifact', () => {
    const bodies: LoopEventVariant[] = [
      { step: 'register', progress: { phase: 'posting-bond', elapsedMs: 0 } },
      { step: 'register', progress: { phase: 'publishing-manifest', elapsedMs: 4000, bondRef: 'bond-1', bondTxId: '0.0.1@1' } },
      {
        step: 'register',
        progress: { phase: 'initializing-reputation', elapsedMs: 17000, bondRef: 'bond-1', manifestTxHash: '0xmanifest' },
      },
      {
        step: 'register',
        progress: {
          phase: 'done',
          elapsedMs: 30000,
          result: {
            bondRef: 'bond-1',
            bondTxId: '0.0.1@1',
            manifestTxHash: '0xmanifest',
            reputationTxHash: '0xrep',
            reputation: { score: 0, jobs: 0, slashes: 0, bondHbar: 30 },
          },
        },
      },
    ];
    const events = stampAll(bodies);
    const mapped = events.flatMap((e) => mapCoreEvent(e));
    expect(mapped.map((m) => m.status)).toEqual(['running', 'running', 'running', 'ok']);
    expect(mapped[3].artifacts).toContainEqual({ label: 'bond tx', value: '0.0.1@1' });
  });
});

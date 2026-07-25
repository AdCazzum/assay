/**
 * Maps `@assay/core`'s `LoopEvent` vocabulary (`packages/core/src/events.ts`,
 * issue #83) onto this package's own `LoopEvent` shape (`events.ts`, issue
 * #30). This is the seam issue #85 asks for: "Consume the event stream core
 * now emits, mapping core's vocabulary onto the dashboard's shape... the
 * mapping lives on this side [not in core]."
 *
 * This is the one file in `@assay/dashboard` that imports `@assay/core` (the
 * package already declares the dependency in `package.json`, unused until
 * now). Every other module here (`events.ts`, `render.ts`, `sink.ts`) stays
 * exactly as core-independent as before: keeping the import contained to
 * this one file is what "keeps the dashboard's own types independent of
 * core" (the issue's own phrasing) means in practice, since the dashboard's
 * `LoopEvent`/`LoopState`/`render`/`attach` do not change shape or gain a
 * dependency just because this mapper exists alongside them.
 *
 * Why this lives in `apps/dashboard` rather than `apps/demo` (the issue
 * offers both as legitimate): `@assay/dashboard`'s `package.json` already
 * declares `@assay/core` as a dependency, put there when the package was
 * scaffolded specifically for this mapping to land in. Putting it here also
 * means the one other consumer of core's events this repo has --
 * `scripts/capture-fixtures.ts` (regenerating the fixtures below from a real
 * run) -- shares the exact same mapping `apps/demo` uses live, rather than
 * two composition roots each writing their own translation that could drift
 * apart.
 *
 * `mapCoreEvent` returns an array because the mapping is not always 1:1:
 * core's `ChallengeLoopEvent` only has `'started'`/`'failed'` phases (no
 * `'ok'`), because core does not consider a challenge "successful" or
 * "failed" in isolation -- the interesting outcome is the *verdict*, carried
 * on the separate `VerifyLoopEvent`. The dashboard's own step model (issue
 * #30, unchanged) renders `challenge` as its own row with a terminal status,
 * though, so a `VerifyLoopEvent` with `committed: true` (i.e. it came from a
 * real `challenge()` call, not the read-only `verifyClaim()`) maps to *two*
 * dashboard events: `challenge` flips to `ok` (the dispute was actually
 * raised and adjudicated) alongside `verify` reporting the verdict itself.
 */

import type { LoopEvent as CoreLoopEvent, Reputation, SettleProgress } from '@assay/core';
import type { Artifact, LoopEvent } from './events.js';

// `@assay/core`'s own per-step variant types (`RegisterLoopEvent`, `PayLoopEvent`,
// ...) do not carry `at`/`seq` — only the full `LoopEvent = LoopEventBase &
// LoopEventVariant` intersection does (see events.ts's doc comment on why
// the union is named before intersecting). `mapPay` needs `at` to compute the
// pay flow's confirm latency, so these helpers are typed as `Extract`s of the
// *full* `CoreLoopEvent` union instead of importing the bare variant types.
type CoreRegisterEvent = Extract<CoreLoopEvent, { step: 'register' }>;
type CoreDiscoverEvent = Extract<CoreLoopEvent, { step: 'discover' }>;
type CorePayEvent = Extract<CoreLoopEvent, { step: 'pay' }>;
type CoreServeEvent = Extract<CoreLoopEvent, { step: 'serve' }>;
type CoreVerifyEvent = Extract<CoreLoopEvent, { step: 'verify' }>;

function hbar(amount: number): string {
  return `${amount} HBAR`;
}

function reputationLine(rep: { score: number; jobs: number; slashes: number }): string {
  return `score ${rep.score}, jobs ${rep.jobs}, slashes ${rep.slashes}`;
}

function mapRegister(event: CoreRegisterEvent): LoopEvent[] {
  const { progress } = event;

  switch (progress.phase) {
    case 'done':
      return [
        {
          step: 'register',
          status: 'ok',
          summary: `manifest published, ${progress.result.bondRef} bond posted`,
          artifacts: [
            { label: 'bond tx', value: progress.result.bondTxId },
            { label: 'manifest tx', value: progress.result.manifestTxHash },
            { label: 'reputation tx', value: progress.result.reputationTxHash },
            { label: 'reputation', value: reputationLine(progress.result.reputation) },
          ],
        },
      ];
    case 'posting-bond':
      return [{ step: 'register', status: 'running', summary: 'posting bond on Hedera testnet...' }];
    case 'publishing-manifest':
      return [{ step: 'register', status: 'running', summary: `publishing manifest (bond ${progress.bondRef})...` }];
    case 'initializing-reputation':
      return [{ step: 'register', status: 'running', summary: `initializing reputation on ENS (bond ${progress.bondRef})...` }];
  }
}

function mapDiscover(event: CoreDiscoverEvent): LoopEvent[] {
  if (event.outcome === 'failed') {
    return [{ step: 'discover', status: 'failed', summary: `resolving "${event.name}" failed: ${event.error.message}` }];
  }

  const { manifest, reputation } = event.provider;
  return [
    {
      step: 'discover',
      status: 'ok',
      summary: `resolved ${event.name}: ${hbar(manifest.priceHbar)}/call, score ${reputation.score}, ${reputation.slashes} slashes`,
      artifacts: [
        { label: 'ens name', value: event.name },
        { label: 'price', value: hbar(manifest.priceHbar) },
        { label: 'reputation', value: reputationLine(reputation) },
        { label: 'bond', value: hbar(reputation.bondHbar) },
      ],
    },
  ];
}

/**
 * Per-flow memory the mapper needs across events, kept to the one thing that
 * cannot be recovered from a single event in isolation: when the current
 * `pay` phase sequence started, so `'confirmed'` can report a real elapsed
 * time (matching the run sheet's "confirmed 4.1s" style) the way
 * `RegisterProgress`/`SettleProgress` already do natively via their own
 * `elapsedMs`. Nothing else here needs history: every other mapped event is
 * a pure function of the one `CoreLoopEvent` it is given.
 */
export type CoreEventMapperState = {
  payPaidAtMs?: number;
};

function mapPay(event: CorePayEvent, state: CoreEventMapperState): LoopEvent[] {
  switch (event.phase) {
    case 'assessed': {
      if (!event.decision.pay) {
        return [
          {
            step: 'pay',
            status: 'failed',
            summary: `declining to pay "${event.name}": ${event.decision.reason}`,
          },
        ];
      }
      const trackRecord = event.assessment.signals.find((s) => s.key === 'trackRecord');
      return [
        {
          step: 'pay',
          status: 'running',
          summary:
            `assessed "${event.name}": ${hbar(event.assessment.priceHbar)}, score ${event.assessment.score}` +
            (trackRecord ? ` — ${trackRecord.detail}` : '') +
            ' — paying...',
        },
      ];
    }
    case 'paid': {
      state.payPaidAtMs = event.at;
      return [
        {
          step: 'pay',
          status: 'running',
          summary: `${hbar(event.amountHbar)} paid, tx ${event.txId}, awaiting mirror-node confirmation...`,
        },
      ];
    }
    case 'confirming':
      return [{ step: 'pay', status: 'running', summary: `confirming ${event.txId} via mirror node...` }];
    case 'confirmed': {
      const elapsedS = state.payPaidAtMs !== undefined ? ((event.at - state.payPaidAtMs) / 1000).toFixed(1) : undefined;
      return [
        {
          step: 'pay',
          status: 'ok',
          summary: `paid, confirmed via mirror node${elapsedS ? ` in ${elapsedS}s` : ''}`,
          artifacts: [{ label: 'tx', value: event.txId }],
        },
      ];
    }
    case 'not-confirmed':
      return [
        {
          step: 'pay',
          status: 'failed',
          summary: `payment ${event.txId} did not confirm${event.reason ? `: ${event.reason}` : ''}`,
        },
      ];
  }
}

function claimArtifacts(claims: readonly { k: string; v: unknown; atBlock: number }[]): Artifact[] {
  const artifacts: Artifact[] = claims.map((claim) => ({ label: `claim ${claim.k}`, value: String(claim.v) }));
  if (claims.length > 0) {
    artifacts.push({ label: 'atBlock', value: String(claims[0].atBlock) });
  }
  return artifacts;
}

function mapServe(event: CoreServeEvent): LoopEvent[] {
  if (event.outcome === 'failed') {
    return [
      {
        step: 'serve',
        status: 'failed',
        summary: `serving "${event.capabilityId}" on "${event.provider}" failed: ${event.error.message}`,
      },
    ];
  }
  const { job } = event;
  return [
    {
      step: 'serve',
      status: 'ok',
      summary: `${job.capabilityId}.run() -> ${JSON.stringify(job.result)}`,
      artifacts: [...claimArtifacts(job.claims), { label: 'jobId', value: job.jobId }],
    },
  ];
}

function mapVerify(event: CoreVerifyEvent): LoopEvent[] {
  const { verdict } = event;
  const verifyEvent: LoopEvent = {
    step: 'verify',
    status: 'ok',
    summary: verdict.valid
      ? 'verdict: VALID — the claim held up against The Graph at the same block.'
      : `verdict: FALSE — claim "${verdict.badClaim ?? event.claimKey}" did not hold up.${verdict.reason ? ` ${verdict.reason}` : ''}`,
    artifacts: verdict.reason ? [{ label: 'reason', value: verdict.reason }] : undefined,
  };

  if (!event.committed) {
    // A read-only verifyClaim() check: nothing moved the job, so there is no
    // corresponding `challenge` row to flip (see the module doc comment).
    return [verifyEvent];
  }

  return [{ step: 'challenge', status: 'ok', summary: `challenge on claim "${event.claimKey}" adjudicated` }, verifyEvent];
}

function mapSettlement(progress: SettleProgress, before?: Reputation): LoopEvent[] {
  switch (progress.phase) {
    case 'slashing':
      return [{ step: 'slash', status: 'running', summary: 'slashing bond to the challenger...' }];
    case 'writing-reputation':
      return [
        {
          step: 'reputation',
          status: 'running',
          summary: before
            ? `writing reputation update to ENS (currently ${reputationLine(before)})...`
            : 'writing reputation update to ENS...',
        },
      ];
    case 'slash-confirmed':
      return [
        {
          step: 'slash',
          status: 'ok',
          summary: 'bond slashed to the challenger',
          artifacts: [{ label: 'tx', value: progress.txId }],
        },
      ];
    case 'slash-failed':
      return [{ step: 'slash', status: 'failed', summary: 'the Hedera slash transaction failed' }];
    case 'reputation-confirmed': {
      const delta = before
        ? [{ label: 'score', value: `${before.score} -> ${progress.reputation.score}` }, { label: 'slashes', value: `${before.slashes} -> ${progress.reputation.slashes}` }]
        : [{ label: 'reputation', value: reputationLine(progress.reputation) }];
      return [
        {
          step: 'reputation',
          status: 'ok',
          summary: `reputation updated on ENS (Sepolia), confirmed after ${(progress.elapsedMs / 1000).toFixed(1)}s`,
          artifacts: [...delta, { label: 'ens tx', value: progress.txHash }],
        },
      ];
    }
    case 'reputation-failed':
      return [{ step: 'reputation', status: 'failed', summary: 'the ENS reputation write failed' }];
    case 'done':
      // The loop's own final beat (`node.ts`): carries no fact either
      // `-confirmed`/`-failed` tick above didn't already report on its own
      // step, so there is nothing new to render here.
      return [];
  }
}

/**
 * Builds a stateful mapper closure (the pay-elapsed-time memory documented
 * on `CoreEventMapperState`). Call once per live `AssayNode` you are
 * narrating and reuse the returned function for every `LoopEvent` that node
 * emits — matching the same "build once, call per event" shape
 * `createEventStamper()` already has in `@assay/core`.
 */
export function createCoreEventMapper(): (event: CoreLoopEvent) => LoopEvent[] {
  const state: CoreEventMapperState = {};
  return (event) => mapCoreEventWithState(event, state);
}

function mapCoreEventWithState(event: CoreLoopEvent, state: CoreEventMapperState): LoopEvent[] {
  switch (event.step) {
    case 'register':
      return mapRegister(event);
    case 'discover':
      return mapDiscover(event);
    case 'pay':
      return mapPay(event, state);
    case 'serve':
      return mapServe(event);
    case 'accept':
      return [{ step: 'accept', status: 'ok', summary: `${event.job.jobId} accepted optimistically, valid until challenged` }];
    case 'challenge':
      return event.phase === 'started'
        ? [{ step: 'challenge', status: 'running', summary: `disputing claim "${event.claimKey}" on job "${event.jobId}"...` }]
        : [{ step: 'challenge', status: 'failed', summary: `challenge on "${event.jobId}" failed: ${event.error.message}` }];
    case 'verify':
      return mapVerify(event);
    case 'slash':
    case 'reputation':
      return mapSettlement(event.progress, event.before);
    /* istanbul ignore next -- exhaustiveness guard, see assertUnreachableEvent's doc comment */
    default:
      return [];
  }
}

/**
 * Stateless convenience for mapping a single, one-off event (tests, or a
 * caller that does not need the pay-elapsed-time memory). Live callers
 * should prefer `createCoreEventMapper()` so a real pay flow's "confirmed
 * Xs" narration works.
 */
export function mapCoreEvent(event: CoreLoopEvent): LoopEvent[] {
  return mapCoreEventWithState(event, {});
}

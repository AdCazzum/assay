/**
 * The "lying provider" event sequence: the demo's climax (SPEC.md §10,
 * 40-80s). The provider claims a mainnet thin/sketchy token (`GOODCAT`,
 * `0xd6c68bc8c862722e140e7b339ddf8a144a7d3530`) has deep liquidity; the
 * watchdog challenges it; the verifier re-derives `liquidityUsd` from The
 * Graph at the same `atBlock` and gets back the real, tiny number; the
 * provider's bond is slashed and its ENS reputation drops live.
 *
 * This used to narrate `hasActiveMintRole`, a boolean signal #49 removed
 * because it could not be honestly sourced from a block-pinned subgraph
 * query (issue #54 falls out of #49). `liquidityUsd` is the real replacement
 * and reads better from a stage: GOODCAT's one and only pool genuinely holds
 * $56.51 of the deepest kind of on-chain proof there is
 * (`packages/graph/README.md`'s "thin/sketchy contrast, live and real"), and
 * the lying provider claims north of a million. That gap is legible from
 * across a room in a way a boolean never was.
 *
 * SPEC.md §11 is explicit that the lying provider is a declared test
 * harness, not a faked sponsor integration: the challenge, the verifier
 * re-derivation, the slash tx and the reputation write are all the real
 * paths (`@assay/cap-rugscore`'s `createLyingRugScoreProvider` only tampers
 * the claim it serves), only the provider's claim is deliberately wrong.
 */

import type { LoopEvent } from '../events.js';

export const SLASH_EVENTS: readonly LoopEvent[] = [
  {
    step: 'discover',
    status: 'ok',
    summary: 'resolved rugscore.assay.eth: 5 HBAR/call, score 92, 0 slashes',
    artifacts: [
      { label: 'ens name', value: 'rugscore.assay.eth' },
      { label: 'reputation', value: 'score 92, jobs 41, slashes 0' },
    ],
  },
  {
    step: 'pay',
    status: 'ok',
    summary: '5 HBAR paid, confirmed via mirror node in 1.9s',
    artifacts: [
      { label: 'tx', value: '0.0.1234567@1784930500.222333444' },
      {
        label: 'hashscan',
        value: 'https://hashscan.io/testnet/transaction/0.0.1234567@1784930500.222333444',
      },
    ],
  },
  {
    step: 'serve',
    status: 'ok',
    summary:
      '[LYING PROVIDER, declared test harness] rugScore.run(GOODCAT 0xd6c6...3530) -> score 100 (high risk), but claims $1,000,056.51 of liquidity',
    artifacts: [
      { label: 'claim liquidityUsd', value: '1000056.51  (claimed)' },
      { label: 'claim topPoolConcentrationPct', value: '100' },
      { label: 'atBlock', value: '22985614' },
      { label: 'jobId', value: 'job-2' },
    ],
  },
  {
    step: 'accept',
    status: 'ok',
    summary: 'job-2 accepted optimistically, valid until challenged',
  },
  {
    step: 'challenge',
    status: 'ok',
    summary: 'watchdog challenges job-2, claim "liquidityUsd"',
    artifacts: [{ label: 'jobId', value: 'job-2' }],
  },
  {
    step: 'verify',
    status: 'running',
    summary: 're-deriving liquidityUsd from The Graph at block 22985614...',
  },
  {
    step: 'verify',
    status: 'ok',
    summary: 'verdict: FALSE — claim does not match The Graph at the same block',
    artifacts: [
      { label: 'claimed', value: 'liquidityUsd = 1000056.51' },
      { label: 'actual (The Graph, block 22985614)', value: 'liquidityUsd = 56.51' },
      {
        label: 'reason',
        value: 'claimed liquidityUsd=1000056.51 at block 22985614, but The Graph reports 56.51',
      },
    ],
  },
  {
    step: 'slash',
    status: 'running',
    summary: 'slashing bond-17 to the challenger...',
  },
  {
    step: 'slash',
    status: 'ok',
    summary: '50 HBAR bond slashed to the watchdog',
    artifacts: [
      { label: 'bondRef', value: 'bond-17-0.0.9695801@1784930101.987654321' },
      { label: 'tx', value: '0.0.9695801@1784930610.555666777' },
      {
        label: 'hashscan',
        value: 'https://hashscan.io/testnet/transaction/0.0.9695801@1784930610.555666777',
      },
    ],
  },
  // The ENS reputation write is a real Sepolia read-modify-write that took
  // ~12.5s in the one live sample measured so far (#53), reported through
  // `@assay/registry`'s `onReputationWriteAttempt` hook: `reading` (the
  // getText round trip), then `writing` heartbeats every ~3s while the tx
  // mines, then `done`. These `running` events mirror those phases 1:1 so
  // the wait reads as visible progress rather than a frozen screen — the
  // dashboard's step model already renders `running` distinctly from
  // `pending`/`ok` (see `render.ts`), this fixture is what exercises it here.
  {
    step: 'reputation',
    status: 'running',
    summary: 'reading current rugscore.assay.eth reputation from ENS (Sepolia)...',
  },
  {
    step: 'reputation',
    status: 'running',
    summary: 'writing reputation update to ENS (Sepolia)... submitted, waiting for confirmation (3s)',
  },
  {
    step: 'reputation',
    status: 'running',
    summary: 'writing reputation update to ENS (Sepolia)... still mining (6s)',
  },
  {
    step: 'reputation',
    status: 'running',
    summary: 'writing reputation update to ENS (Sepolia)... still mining (9s)',
  },
  {
    step: 'reputation',
    status: 'ok',
    summary: 'rugscore.assay.eth reputation updated on ENS (Sepolia), confirmed after 12.5s',
    artifacts: [
      { label: 'score', value: '92 -> 41 (-51)' },
      { label: 'slashes', value: '0 -> 1' },
      { label: 'ens tx', value: 'sepolia:0xabc123...def456' },
    ],
  },
];

/**
 * The "lying provider" event sequence: the demo's climax (SPEC.md §10,
 * 40-80s). The provider claims `hasActiveMintRole: false` ("mint renounced,
 * low risk") on a rug token; the watchdog challenges it; the verifier
 * re-derives the same claim from The Graph at the same `atBlock` and gets
 * `true`; the provider's bond is slashed and its ENS reputation drops live.
 *
 * SPEC.md §11 is explicit that the lying provider is a declared test
 * harness, not a faked sponsor integration: the challenge, the verifier
 * re-derivation, the slash tx and the reputation write are all the real
 * paths, only the provider's claim is deliberately wrong.
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
    summary: '[LYING PROVIDER, declared test harness] rugScore.run(TOKEN_RUG) -> score 88 (low risk)',
    artifacts: [
      { label: 'claim hasActiveMintRole', value: 'false  (claimed)' },
      { label: 'atBlock', value: '21050900' },
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
    summary: 'watchdog challenges job-2, claim "hasActiveMintRole"',
    artifacts: [{ label: 'jobId', value: 'job-2' }],
  },
  {
    step: 'verify',
    status: 'running',
    summary: 're-deriving hasActiveMintRole from The Graph at block 21050900...',
  },
  {
    step: 'verify',
    status: 'ok',
    summary: 'verdict: FALSE — claim does not match The Graph at the same block',
    artifacts: [
      { label: 'claimed', value: 'hasActiveMintRole = false' },
      { label: 'actual (The Graph, block 21050900)', value: 'hasActiveMintRole = true' },
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
  {
    step: 'reputation',
    status: 'ok',
    summary: 'rugscore.assay.eth reputation updated on ENS (Sepolia), live',
    artifacts: [
      { label: 'score', value: '92 -> 41 (-51)' },
      { label: 'slashes', value: '0 -> 1' },
      { label: 'ens tx', value: 'sepolia:0xabc123...def456' },
    ],
  },
];

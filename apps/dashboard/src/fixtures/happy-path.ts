/**
 * The canonical happy-path event sequence: register through accept, no
 * challenge. Mirrors SPEC.md §10's 0-40s beats (discover -> pay + serve),
 * extended with register at the front and accept at the end so the whole
 * loop up to "optimistically valid" is covered.
 *
 * Values are shaped like the real thing (an ENS name, an HBAR price, a
 * HashScan testnet URL, a mainnet block number) but this file runs no
 * network call itself: it exists so the dashboard can be rehearsed with zero
 * network, per issue #30 / SPEC.md §14's rehearsal budget.
 */

import type { LoopEvent } from '../events.js';

export const HAPPY_PATH_EVENTS: readonly LoopEvent[] = [
  {
    step: 'register',
    status: 'running',
    summary: 'publishing manifest + posting bond for rugscore.assay.eth...',
  },
  {
    step: 'register',
    status: 'ok',
    summary: 'manifest published, 50 HBAR bond posted',
    artifacts: [
      { label: 'manifest tx', value: '0.0.9695801@1784930100.123456789' },
      { label: 'bond tx', value: '0.0.9695801@1784930101.987654321' },
      {
        label: 'hashscan (bond)',
        value: 'https://hashscan.io/testnet/transaction/0.0.9695801@1784930101.987654321',
      },
    ],
  },
  {
    step: 'discover',
    status: 'ok',
    summary: 'resolved rugscore.assay.eth: 5 HBAR/call, score 92, 0 slashes',
    artifacts: [
      { label: 'ens name', value: 'rugscore.assay.eth' },
      { label: 'price', value: '5 HBAR' },
      { label: 'reputation', value: 'score 92, jobs 41, slashes 0' },
    ],
  },
  {
    step: 'pay',
    status: 'running',
    summary: 'paying 5 HBAR on Hedera testnet...',
  },
  {
    step: 'pay',
    status: 'ok',
    summary: '5 HBAR paid, confirmed via mirror node in 2.4s',
    artifacts: [
      { label: 'tx', value: '0.0.1234567@1784930210.111222333' },
      {
        label: 'hashscan',
        value: 'https://hashscan.io/testnet/transaction/0.0.1234567@1784930210.111222333',
      },
    ],
  },
  {
    step: 'serve',
    status: 'ok',
    summary: 'rugScore.run(TOKEN_X) -> score 81 (low risk)',
    artifacts: [
      { label: 'claim holders', value: '18432' },
      { label: 'claim hasActiveMintRole', value: 'false' },
      { label: 'atBlock', value: '21050112' },
      { label: 'jobId', value: 'job-1' },
    ],
  },
  {
    step: 'accept',
    status: 'ok',
    summary: 'job-1 accepted optimistically, no challenge raised',
  },
];

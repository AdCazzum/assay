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
 *
 * The claim values below are not invented: they are the live-measured
 * numbers `cap-rugscore` got back from the real Uniswap v3 subgraph for USDC
 * (`0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`, #49 /
 * `packages/graph/README.md`) — ~$361.2M liquidity in its deepest pool, ages
 * 13,235,876 blocks, 36,491,026 swaps/mints/burns, 43.98% top-pool
 * concentration. Run through the real `scoreRugPullRisk` these signals score
 * 9 (low risk), which is what `serve` reports. This fixture used to narrate
 * `hasActiveMintRole`, a signal #49 removed because it could not be honestly
 * sourced from a block-pinned query (issue #54).
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
    summary: 'rugScore.run(USDC 0xa0b8...eb48) -> score 9 (low risk)',
    artifacts: [
      { label: 'claim liquidityUsd', value: '361202208' },
      { label: 'claim ageBlocks', value: '13235876' },
      { label: 'claim txCount', value: '36491026' },
      { label: 'claim topPoolConcentrationPct', value: '43.98' },
      { label: 'atBlock', value: '22984210' },
      { label: 'jobId', value: 'job-1' },
    ],
  },
  {
    step: 'accept',
    status: 'ok',
    summary: 'job-1 accepted optimistically, no challenge raised',
  },
];

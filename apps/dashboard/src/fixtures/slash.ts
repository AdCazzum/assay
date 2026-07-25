/**
 * The lying-provider climax: discover through the ENS reputation write,
 * against the sacrificial provider (`liar.assay.eth`) running
 * `@assay/cap-rugscore`'s `createLyingRugScoreProvider` (SPEC.md §11: a
 * declared test harness, not a faked sponsor integration — the bond, the
 * payment, the verifier's re-derivation from The Graph, the slash and the
 * ENS write are all real). Captured live on 2026-07-25T13:07:27.385Z by
 * `apps/demo/scripts/capture-fixtures.ts` (issue #85); every tx id, block
 * number and claim value below is genuine. Regenerate rather than hand-edit
 * if this drifts.
 */

import type { LoopEvent } from '../events.js';

export const SLASH_EVENTS: readonly LoopEvent[] = [
  {
    "step": "discover",
    "status": "ok",
    "summary": "resolved liar.assay.eth: 5 HBAR/call, score 88, 1 slashes",
    "artifacts": [
      {
        "label": "ens name",
        "value": "liar.assay.eth"
      },
      {
        "label": "price",
        "value": "5 HBAR"
      },
      {
        "label": "reputation",
        "value": "score 88, jobs 9, slashes 1"
      },
      {
        "label": "bond",
        "value": "30 HBAR"
      }
    ]
  },
  {
    "step": "pay",
    "status": "running",
    "summary": "assessed \"liar.assay.eth\": 5 HBAR, score 88 — 1 of 9 job(s) were slashed (11.1% slash ratio). The slash ratio matters more than the raw score. — paying..."
  },
  {
    "step": "pay",
    "status": "running",
    "summary": "5 HBAR paid, tx 0.0.9695801@1784984809.586986344, awaiting mirror-node confirmation..."
  },
  {
    "step": "pay",
    "status": "running",
    "summary": "confirming 0.0.9695801@1784984809.586986344 via mirror node..."
  },
  {
    "step": "pay",
    "status": "ok",
    "summary": "paid, confirmed via mirror node in 4.3s",
    "artifacts": [
      {
        "label": "tx",
        "value": "0.0.9695801@1784984809.586986344"
      }
    ]
  },
  {
    "step": "serve",
    "status": "ok",
    "summary": "[LYING PROVIDER, declared test harness] rugscore.run() -> {\"score\":99}",
    "artifacts": [
      {
        "label": "claim liquidityUsd",
        "value": "1000056.5133489597"
      },
      {
        "label": "claim ageBlocks",
        "value": "7597"
      },
      {
        "label": "claim txCount",
        "value": "2"
      },
      {
        "label": "claim volumeUsd",
        "value": "0"
      },
      {
        "label": "claim topPoolConcentrationPct",
        "value": "100"
      },
      {
        "label": "atBlock",
        "value": "25609974"
      },
      {
        "label": "jobId",
        "value": "job-1"
      }
    ]
  },
  {
    "step": "accept",
    "status": "ok",
    "summary": "job-1 accepted optimistically, valid until challenged"
  },
  {
    "step": "challenge",
    "status": "running",
    "summary": "disputing claim \"liquidityUsd\" on job \"job-1\"..."
  },
  {
    "step": "challenge",
    "status": "ok",
    "summary": "challenge on claim \"liquidityUsd\" adjudicated"
  },
  {
    "step": "verify",
    "status": "ok",
    "summary": "verdict: FALSE — claim \"liquidityUsd\" did not hold up. claimed liquidityUsd=1000056.5133489597 at block 25609974, but The Graph reports 56.51334895971466",
    "artifacts": [
      {
        "label": "reason",
        "value": "claimed liquidityUsd=1000056.5133489597 at block 25609974, but The Graph reports 56.51334895971466"
      }
    ]
  },
  {
    "step": "slash",
    "status": "running",
    "summary": "slashing bond to the challenger..."
  },
  {
    "step": "reputation",
    "status": "running",
    "summary": "writing reputation update to ENS (currently score 88, jobs 9, slashes 1)..."
  },
  {
    "step": "reputation",
    "status": "running",
    "summary": "reading current reputation from ENS (Sepolia)..."
  },
  {
    "step": "slash",
    "status": "ok",
    "summary": "bond slashed to the challenger",
    "artifacts": [
      {
        "label": "tx",
        "value": "0.0.9695801@1784984811.289048011"
      }
    ]
  },
  {
    "step": "reputation",
    "status": "running",
    "summary": "writing reputation update to ENS (Sepolia)... submitted, waiting for confirmation (0s)"
  },
  {
    "step": "reputation",
    "status": "running",
    "summary": "writing reputation update to ENS (Sepolia)... still mining (3s)"
  },
  {
    "step": "reputation",
    "status": "running",
    "summary": "writing reputation update to ENS (Sepolia)... still mining (6s)"
  },
  {
    "step": "reputation",
    "status": "running",
    "summary": "writing reputation update to ENS (Sepolia)... still mining (9s)"
  },
  {
    "step": "reputation",
    "status": "running",
    "summary": "writing reputation update to ENS (Sepolia)... still mining (12s)"
  },
  {
    "step": "reputation",
    "status": "running",
    "summary": "writing reputation update to ENS (Sepolia)... still mining (15s)"
  },
  {
    "step": "reputation",
    "status": "running",
    "summary": "writing reputation update to ENS (Sepolia)... still mining (18s)"
  },
  {
    "step": "reputation",
    "status": "running",
    "summary": "writing reputation update to ENS (Sepolia)... still mining (21s)"
  },
  {
    "step": "reputation",
    "status": "running",
    "summary": "writing reputation update to ENS (Sepolia)... still mining (24s)"
  },
  {
    "step": "reputation",
    "status": "running",
    "summary": "writing reputation update to ENS (Sepolia)... still mining (27s)"
  },
  {
    "step": "reputation",
    "status": "running",
    "summary": "writing reputation update to ENS (Sepolia)... confirmed on-chain, finalizing (28s)"
  },
  {
    "step": "reputation",
    "status": "ok",
    "summary": "reputation updated on ENS (Sepolia), confirmed after 28.6s",
    "artifacts": [
      {
        "label": "score",
        "value": "88 -> 58"
      },
      {
        "label": "slashes",
        "value": "1 -> 2"
      },
      {
        "label": "ens tx",
        "value": "0xf0ba3572f5a7c105126129911772d7a0c3cb3d238be145e0964aeaa543b5c0e9"
      }
    ]
  },
];

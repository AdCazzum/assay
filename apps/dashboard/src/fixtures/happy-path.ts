/**
 * The canonical happy-path event sequence: discover through accept, no
 * challenge, against the real good provider (`rugscore.assay.eth`).
 * Captured live from a real run on 2026-07-25T13:07:27.385Z by `apps/demo/scripts/capture-fixtures.ts`
 * (issue #85) — every value below is a genuine Hedera/ENS/Graph artifact
 * from that run, mapped through the exact same `@assay/dashboard`
 * `createCoreEventMapper` the live demo drives, not hand-written.
 * Regenerate rather than hand-edit if this drifts.
 */

import type { LoopEvent } from '../events.js';

export const HAPPY_PATH_EVENTS: readonly LoopEvent[] = [
  {
    "step": "discover",
    "status": "ok",
    "summary": "resolved rugscore.assay.eth: 5 HBAR/call, score 78, 0 slashes",
    "artifacts": [
      {
        "label": "ens name",
        "value": "rugscore.assay.eth"
      },
      {
        "label": "price",
        "value": "5 HBAR"
      },
      {
        "label": "reputation",
        "value": "score 78, jobs 14, slashes 0"
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
    "summary": "assessed \"rugscore.assay.eth\": 5 HBAR, score 78 — Clean record: 0 slashes across 14 job(s). — paying..."
  },
  {
    "step": "pay",
    "status": "running",
    "summary": "5 HBAR paid, tx 0.0.9695801@1784984784.320798116, awaiting mirror-node confirmation..."
  },
  {
    "step": "pay",
    "status": "running",
    "summary": "confirming 0.0.9695801@1784984784.320798116 via mirror node..."
  },
  {
    "step": "pay",
    "status": "ok",
    "summary": "paid, confirmed via mirror node in 3.3s",
    "artifacts": [
      {
        "label": "tx",
        "value": "0.0.9695801@1784984784.320798116"
      }
    ]
  },
  {
    "step": "serve",
    "status": "ok",
    "summary": "rugscore.run() -> {\"score\":9}",
    "artifacts": [
      {
        "label": "claim liquidityUsd",
        "value": "362129022.3835049"
      },
      {
        "label": "claim ageBlocks",
        "value": "13240212"
      },
      {
        "label": "claim txCount",
        "value": "36508101"
      },
      {
        "label": "claim volumeUsd",
        "value": "1020082615632.7941"
      },
      {
        "label": "claim topPoolConcentrationPct",
        "value": "44.06976671161385"
      },
      {
        "label": "atBlock",
        "value": "25609972"
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
];

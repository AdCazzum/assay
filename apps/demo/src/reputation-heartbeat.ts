/**
 * Turns `@assay/registry`'s `onReputationWriteAttempt` ticks into the
 * dashboard's `reputation` row narration (see `live-node.ts`'s module doc
 * comment on why this hook exists separately from `@assay/core`'s own
 * `LoopEvent` stream). `docs/demo-run-sheet.md`: "The dashboard shows a real
 * heartbeat every 3 seconds off the ENS write's own progress, so the screen
 * is alive rather than frozen" — this is what produces that heartbeat text.
 *
 * Deliberately renders nothing for the `'done'` phase: `AssayNode.settle()`'s
 * own `'reputation-confirmed'` `SettlementLoopEvent` (mapped by
 * `createCoreEventMapper`) fires immediately afterward with the real
 * before/after score delta and the ENS tx hash — richer than anything this
 * lower-level hook alone carries — so this heartbeat only ever needs to
 * cover the *waiting* window, not the landing.
 */

import type { ReputationWriteProgress } from '@assay/registry';
import type { LoopEvent } from '@assay/dashboard';

export function formatReputationHeartbeat(info: ReputationWriteProgress): LoopEvent | undefined {
  const seconds = (info.elapsedMs / 1000).toFixed(0);
  switch (info.phase) {
    case 'reading':
      return { step: 'reputation', status: 'running', summary: 'reading current reputation from ENS (Sepolia)...' };
    case 'writing':
      switch (info.writeState) {
        case 'submitted':
          return { step: 'reputation', status: 'running', summary: `writing reputation update to ENS (Sepolia)... submitted, waiting for confirmation (${seconds}s)` };
        case 'pending':
          return { step: 'reputation', status: 'running', summary: `writing reputation update to ENS (Sepolia)... still mining (${seconds}s)` };
        case 'confirmed':
          return { step: 'reputation', status: 'running', summary: `writing reputation update to ENS (Sepolia)... confirmed on-chain, finalizing (${seconds}s)` };
      }
      break;
    case 'done':
      return undefined;
  }
}

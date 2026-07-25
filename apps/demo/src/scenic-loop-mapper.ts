/**
 * Bridges a parsed sink line (`sink-tailer.ts`'s loose `ParsedSinkLine`) into
 * the dashboard's own `LoopEvent` shape, reusing exactly two pieces of
 * already-tested code rather than inventing a third mapping:
 *
 *  - a real `{ kind: 'loop-event' }` line is `@assay/core`'s own `LoopEvent`
 *    (`apps/mcp/src/loop-event-sink.ts` serializes it verbatim), so it goes
 *    straight through `@assay/dashboard`'s `createCoreEventMapper()` -- the
 *    exact function the live in-process demo already used.
 *  - a `{ kind: 'heartbeat', of: 'reputation-write' }` line carries the same
 *    fields as `@assay/registry`'s `ReputationWriteProgress`
 *    (`apps/mcp/src/index.ts` spreads `info` straight onto it), so it feeds
 *    `apps/demo`'s own already-tested `formatReputationHeartbeat()` --
 *    unchanged, only its input source moves from an in-process callback to a
 *    parsed sink line (this is the design doc's single strongest "reuse,
 *    don't invent" point).
 *
 * A `payment-confirm` heartbeat has no dashboard row of its own yet (core's
 * `pay` step already narrates `confirming`/`confirmed` at the LoopEvent
 * level); this file surfaces it only as an activity signal the caller can
 * use for its own "still alive" bookkeeping, never as an invented dashboard
 * row.
 */

import { formatReputationHeartbeat } from './reputation-heartbeat.js';
import type { ParsedSinkLine } from './sink-tailer.js';
import { createCoreEventMapper } from '@assay/dashboard';
import type { LoopEvent as CoreLoopEvent } from '@assay/core';
import type { ReputationWriteProgress } from '@assay/registry';
import type { LoopEvent } from '@assay/dashboard';

const REPUTATION_WRITE_PHASES = new Set(['reading', 'writing', 'done']);

function toReputationWriteProgress(heartbeat: Record<string, unknown>): ReputationWriteProgress | undefined {
  if (heartbeat.of !== 'reputation-write') return undefined;
  const phase = heartbeat.phase;
  if (typeof phase !== 'string' || !REPUTATION_WRITE_PHASES.has(phase)) return undefined;
  // Structurally identical to ReputationWriteProgress by construction (see
  // the module doc comment: apps/mcp's index.ts spreads the real `info` this
  // hook received straight onto the sink line) -- cast, not re-validated
  // field by field, matching `run-agent.ts`'s own "render best-effort from
  // whatever shape arrives" posture for the sibling agent-stream parser.
  return heartbeat as unknown as ReputationWriteProgress;
}

export type ScenicLoopMapperResult = {
  /** Dashboard events to fold into the loop pane's `LoopState`, in order. */
  events: LoopEvent[];
  /** True if this line was a real LoopEvent (drives the HUD's loop-events freshness clock; a heartbeat line does not, since it is not the fact #93 itself asked to stream). */
  isRealLoopEvent: boolean;
};

/**
 * Builds a stateful mapper (the pay-elapsed-time memory `createCoreEventMapper`
 * needs, see its own doc comment) bound to one scenic run.
 */
export function createScenicLoopMapper(): (parsed: ParsedSinkLine) => ScenicLoopMapperResult {
  const mapCoreEvent = createCoreEventMapper();
  return (parsed) => {
    if (parsed.kind === 'loop-event') {
      // Loose by construction (see sink-tailer.ts's own doc comment on why
      // it does not import @assay/core's LoopEvent type): cast here, at the
      // one seam that actually needs the real shape.
      const events = mapCoreEvent(parsed.event as unknown as CoreLoopEvent);
      return { events, isRealLoopEvent: true };
    }
    if (parsed.kind === 'heartbeat') {
      const progress = toReputationWriteProgress(parsed.heartbeat);
      if (!progress) return { events: [], isRealLoopEvent: false };
      const event = formatReputationHeartbeat(progress);
      return { events: event ? [event] : [], isRealLoopEvent: false };
    }
    return { events: [], isRealLoopEvent: false };
  };
}

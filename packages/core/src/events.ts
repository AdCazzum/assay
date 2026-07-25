/**
 * The loop's own narration vocabulary (issue #83). `createAssayNode` emits
 * these through the optional `AssayNodeConfig.onLoopEvent` hook as the loop
 * actually runs. This is the one new export surface #83 adds (plus
 * `AssayNode.verifyClaim`, see `node.ts`).
 *
 * Two things this deliberately is NOT:
 *  - It is not `apps/dashboard`'s `LoopEvent` (apps/dashboard/src/events.ts).
 *    That type stays there; core must never import from an app. The two
 *    share a name and a similar shape because they describe the same loop,
 *    not because one depends on the other. Whoever wires a live run
 *    (apps/mcp, apps/demo) maps this onto the dashboard's own vocabulary.
 *  - It is not a replacement for `RegisterProgress` / `SettleProgress`
 *    (node.ts). Those keep reporting exactly as before; the register/slash/
 *    reputation variants below just wrap the same tick a caller already gets
 *    from onRegisterProgress/onSettleProgress, so a slow ENS write still
 *    reports its heartbeat without this file re-deriving elapsed time or
 *    phase bookkeeping node.ts already computes.
 */

import type { RegisterProgress, SettleProgress } from './node.js';
import type { ProviderAssessment } from './assessment.js';
import type { PayDecision } from './pay-policy.js';
import type { Claim, Job, ProviderRecord, Reputation, Verdict } from './types.js';

/**
 * Every `LoopEvent` carries this. `at` is `Date.now()` when core observed the
 * fact, not when a consumer receives it. `seq` is a monotonically increasing
 * counter scoped to whichever `EventStamper` produced this event (see
 * `createEventStamper` below) -- `at` alone cannot give a strict total order
 * across `settle()`'s two concurrent legs (slash + reputation write) under
 * fast execution, since both can land in the same millisecond.
 */
type LoopEventBase = { at: number; seq: number };

/**
 * The step-specific half of a `LoopEvent` -- everything except the base
 * `at`/`seq` every event carries, kept as its own named union rather than
 * expressed as `Omit<LoopEvent, 'at' | 'seq'>`. That is a deliberate,
 * concrete fix over the judged design's own sketch (which used the `Omit`
 * form): TypeScript's built-in `Omit`/`Pick` compute `keyof T` first, and
 * `keyof` of a union type collapses to only the keys every member shares in
 * common (here, just `step`) -- so `Omit<LoopEvent, 'at' | 'seq'>` would
 * silently widen to a near-useless `{ step: ... }` shape and every call site
 * that builds a `phase`/`outcome`/`job`/etc. field into an event body would
 * fail to typecheck. Naming this union before intersecting it with
 * `LoopEventBase` sidesteps the collapse entirely and keeps `LoopEvent`
 * itself exactly the shape the design specifies.
 */
export type LoopEventVariant =
  | RegisterLoopEvent
  | DiscoverLoopEvent
  | PayLoopEvent
  | ServeLoopEvent
  | AcceptLoopEvent
  | ChallengeLoopEvent
  | VerifyLoopEvent
  | SettlementLoopEvent;

/**
 * One fact about the loop, emitted the instant core observes it. A flat
 * union tagged on `step`; most steps also carry a `phase`/`outcome` so a
 * fast-completing step (discover, serve, verify) goes straight to its
 * terminal fact in one event, while a slow one (register, settle's slash and
 * reputation legs) reports the same phase-by-phase heartbeat its existing
 * progress hook already computes.
 *
 * Deliberately NOT one config callback per step (onDiscover, onPay, ...):
 * one union and one hook is the whole new surface this issue adds.
 */
export type LoopEvent = LoopEventBase & LoopEventVariant;

/** SPEC.md §7 step 1. One event per `RegisterProgress` tick, wrapped as-is: same phases, same `elapsedMs`, nothing re-derived. */
export type RegisterLoopEvent = { step: 'register'; progress: RegisterProgress };

/** SPEC.md §7 step 2. `discover()`'s own result: the manifest + reputation a requester reasons over next. */
export type DiscoverLoopEvent =
  | { step: 'discover'; outcome: 'ok'; name: string; provider: ProviderRecord }
  | { step: 'discover'; outcome: 'failed'; name: string; error: Error };

/**
 * SPEC.md §7 steps 2-3: the pay decision, its reasoning, the payment, and its
 * confirmation, all under one step id (matching apps/dashboard's single
 * 'pay' row, so a consumer built against that vocabulary needs no extra
 * step). `phase` distinguishes the four moments:
 *
 *  - 'assessed'  — evaluatePayDecision ran. `decision.pay` says whether
 *    payAndCall will actually pay; `assessment` is the same structured read
 *    (ProviderAssessment.signals) a live agent reasons over via the MCP
 *    discover tool, so a narrator can print the real "reputazione ok, 5
 *    HBAR, pago" reasoning, not a canned line. Always fires, decline or not.
 *  - 'paid'      — payments.pay() returned; real HBAR left, `txId` is a real
 *    Hedera transaction id (HashScan-checkable).
 *  - 'confirming'— about to poll the mirror node for `txId`. No per-poll
 *    heartbeat here (payments' own onConfirmAttempt owns that, bound at
 *    adapter-construction, out of core's reach) — this is one tick marking
 *    the wait has started.
 *  - 'confirmed' / 'not-confirmed' — the mirror-node verdict serve() gates
 *    on (SPEC.md §12).
 */
export type PayLoopEvent =
  | { step: 'pay'; phase: 'assessed'; name: string; assessment: ProviderAssessment; decision: PayDecision }
  | { step: 'pay'; phase: 'paid'; name: string; txId: string; amountHbar: number }
  | { step: 'pay'; phase: 'confirming'; txId: string }
  | { step: 'pay'; phase: 'confirmed'; txId: string }
  | { step: 'pay'; phase: 'not-confirmed'; txId: string; reason?: string };

/** SPEC.md §7 step 4: the provider ran the capability and the job now carries block-stamped claims. */
export type ServeLoopEvent =
  | { step: 'serve'; outcome: 'ok'; job: Job }
  | { step: 'serve'; outcome: 'failed'; provider: string; capabilityId: string; txId: string; error: Error };

/**
 * SPEC.md §7 step 5. Not a distinct core action — a served job is accepted
 * "optimistic by default" the instant it exists — so this fires immediately
 * after a ServeLoopEvent with outcome 'ok', same `job`, restating the fact
 * under its own dashboard-matching step id rather than making the dashboard
 * infer "accepted" from "served".
 */
export type AcceptLoopEvent = { step: 'accept'; job: Job };

/** SPEC.md §7 step 6, the committing half. `verifyClaim` (read-only) reports through `VerifyLoopEvent` instead, never this one. */
export type ChallengeLoopEvent =
  | { step: 'challenge'; phase: 'started'; jobId: string; claimKey: string }
  | { step: 'challenge'; phase: 'failed'; jobId: string; claimKey: string; error: Error };

/**
 * The verdict itself, from either challenge() or the read-only verifyClaim()
 * (issue #83's second half). `committed` is the one field that tells them
 * apart: true means the job actually moved served -> challenged on this
 * verdict (a ChallengeLoopEvent with phase 'started' preceded it); false
 * means this was verifyClaim checking the same claim without moving
 * anything. `claims` is the job's full claim set (each already carrying its
 * own atBlock) the verifier re-derived against — the "at the claim's own
 * atBlock" rule made visible, not just asserted.
 */
export type VerifyLoopEvent = {
  step: 'verify';
  jobId: string;
  claimKey: string;
  claims: Claim[];
  verdict: Verdict;
  committed: boolean;
};

/**
 * SPEC.md §7 steps 7-8: settle()'s two legs. One SettleProgress tick in, one
 * event out — 'slashing'/'slash-confirmed'/'slash-failed' map to step
 * 'slash', everything else to step 'reputation' (including 'done', which
 * fires here since it is the loop's own final beat and carries no fact
 * reputation-confirmed/-failed didn't already report). `before` is the
 * provider's reputation as settle() read it right before writing, attached
 * only on the reputation-side phases, since that read already happened in
 * scope and the dashboard needs the delta, not just the after value
 * `progress` already carries on 'reputation-confirmed'.
 */
export type SettlementLoopEvent = {
  step: 'slash' | 'reputation';
  progress: SettleProgress;
  before?: Reputation;
};

/**
 * Stamps a `LoopEvent` body with `at` (`Date.now()`) and a `seq` that
 * increments once per call, scoped to the returned function's own closure.
 *
 * Why this exists (graft from the losing proposals, see the design doc):
 * `at: Date.now()` alone cannot give a strict total order across `settle()`'s
 * two concurrent legs (the Hedera slash and the ENS reputation write can both
 * resolve within the same millisecond), and it says nothing at all about
 * ordering a node's own emitted events against whatever a composition root
 * synthesizes itself outside `AssayNode` entirely (concretely: apps/mcp's
 * `rate()`, which lives in `live-node.ts` and is invisible to this event
 * stream — see the design doc's named tradeoff on that).
 *
 * `createAssayNode` calls this once per node by default (see
 * `AssayNodeConfig.eventStamper`) to stamp every `LoopEvent` it emits. A
 * composition root that also synthesizes its own events outside the node
 * (again: apps/mcp's `rate()`) should call `createEventStamper()` itself
 * once, pass the same stamper into `createAssayNode({ eventStamper })`, and
 * reuse that exact function to stamp its own synthetic events too — that is
 * the only way to get one shared, strictly increasing `seq` across both
 * sources; two independently-constructed stampers do not share a counter.
 */
export function createEventStamper(): (body: LoopEventVariant) => LoopEvent {
  let seq = 0;
  return (body) => {
    seq += 1;
    return { at: Date.now(), seq, ...body };
  };
}

/**
 * Compile-time exhaustiveness helper (graft from the losing proposals, see
 * the design doc). Call this in the `default`/`else` branch of a
 * `switch (event.step)` (or equivalent) over a `LoopEvent`: if a variant is
 * ever added or renamed without updating that switch, `event` there will no
 * longer be typed `never` and the call site fails to typecheck, instead of
 * silently falling through at runtime. Not used anywhere in `packages/core`
 * itself (core only emits events, it never switches over its own union) —
 * this is exported for the three consumers (apps/mcp, apps/dashboard,
 * apps/demo) that do.
 */
export function assertUnreachableEvent(event: never): never {
  throw new Error(`Unreachable LoopEvent variant: ${JSON.stringify(event)}`);
}

/**
 * The demo's live step runners (issue #86): discover / pay / serve /
 * challenge, each a real call against the live nodes `live-node.ts` builds.
 * Sequencing (guard against restarting a running step, "advancing is
 * explicit") is `step-machine.ts`'s job, shared with the offline rehearsal
 * (`rehearsal.ts`); this file only supplies what each of the four keys
 * actually *does*.
 *
 * `discover`/`serve`/`challenge` narrate themselves for free: the caller
 * wires each `AssayNode`'s `onLoopEvent` (at construction, see `main.ts`)
 * through `@assay/dashboard`'s `createCoreEventMapper`, pushing mapped
 * `LoopEvent`s straight into the screen — this file does not construct
 * those dashboard events itself for those three steps.
 *
 * **Why pay is different.** `AssayNode.payAndCall()` pays *and* serves in
 * one call; there is no public way to pay without also running the
 * capability through it. The run sheet's mockup shows Pay landing
 * ("confirmed 4.1s") as its own beat before Serve even starts, and issue #86
 * lists them as separate keys the presenter presses when *they* are ready.
 * So the pay step calls `payments.pay()`/`payments.confirmPayment()`
 * directly — the same bypass `apps/mcp/src/live-node.ts`'s `force: true`
 * path and `apps/watchdog/src/serve-for-challenge.ts` already establish —
 * and defers `requesterNode.serve()` (the real capability run, still gated
 * on the real payment, SPEC.md §12) to its own key. Because this path never
 * calls `payAndCall`, core emits no `PayLoopEvent` for it, so this step
 * constructs its own `pay` dashboard events directly instead of relying on
 * the mapper (which stays exercised by the fixture capture script, which
 * *does* use `payAndCall`, and by its own unit tests in `apps/dashboard`).
 *
 * One consequence of that split, verified live: `AssayNode.serve()` itself
 * unconditionally re-verifies the payment (SPEC.md §12, "structurally
 * impossible to bypass") every time it runs, which means the serve step
 * below *also* makes core emit its own `'pay'` `phase: 'confirming'`/
 * `'confirmed'` events — a real, second, but much thinner re-narration of a
 * payment this file already reported in full. Left unhandled, that would
 * downgrade the pay row's rich "confirmed in 5.7s, tx ..." back to a bare
 * "paid, confirmed via mirror node" the instant serve starts. `onPayFinalizing`
 * (called once, right before that `serve()` call) is how this file tells its
 * caller to stop forwarding `'pay'` events from here on — safe to do
 * permanently, because this session's step order never revisits `pay` once
 * `serve` has begun (see `step-machine.ts`'s `STEP_ORDER`).
 *
 * **Why the challenge step's own preamble is not narrated.** Pressing "4
 * challenge" first re-bonds and serves a fresh job against the *sacrificial*
 * provider (`liarProviderName`) with the declared lying-provider harness
 * (SPEC.md §11) — the `serve-for-challenge.ts` idiom, reimplemented here
 * against `challengeNode` — before it can challenge anything. If that
 * preamble's own discover/pay/serve/accept events were narrated the same
 * way the requester's are, they would overwrite the good provider's rows
 * (the dashboard has one row per step id, issue #30, "that design is right
 * and stays") with the liar's numbers, erasing the real narrative the
 * audience just watched. So `challengeNode` is built (see `main.ts`) with an
 * `onLoopEvent` that only forwards `challenge`/`verify`/`slash`/`reputation`
 * — a composition-root decision, not something this file re-derives. This
 * file pushes exactly one synthetic event up front, the moment the key is
 * pressed and before any network call: `challenge: running`, so the screen
 * shows something live immediately instead of staying frozen for the
 * ~15-20s the silent preamble takes (a frozen screen at the climax is the
 * failure mode this whole issue exists to prevent).
 */

import { createHash } from 'node:crypto';
import {
  DEFAULT_PAY_DECISION_POLICY,
  evaluatePayDecision,
  type AssayNode,
  type Job,
  type Manifest,
  type PaymentsPort,
  type ProviderRecord,
  type RegistryPort,
} from '@assay/core';
import type { LoopEvent } from '@assay/dashboard';
import { createStepMachine, type DemoSession, type StepRunners } from './step-machine.js';

export {
  STEP_KEYS,
  STEP_ORDER,
  keyFor,
  type DemoSession,
  type DemoSessionState,
  type DemoStepId,
} from './step-machine.js';

/** Binds a payment to the exact request it pays for — same construction `@assay/core`'s `node.ts` (not exported) and `apps/watchdog`'s `serve-for-challenge.ts` (its own copy) both use. */
function hashRequest(capabilityId: string, request: unknown): string {
  return createHash('sha256').update(JSON.stringify({ capabilityId, request })).digest('hex');
}

/** The USDC token the real live agent (`apps/mcp/agent/prompt.md`) already asks the good provider about. Reused here so the demo scores the same, already-verified-live token (packages/graph/README.md). */
export const DEFAULT_REQUEST_TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
/** GOODCAT: the thin, real mainnet token `apps/watchdog` already uses as its default challenge target — verified live to score high-risk. */
export const DEFAULT_LIAR_TOKEN = '0xd6c68bc8c862722e140e7b339ddf8a144a7d3530';
export const DEFAULT_CLAIM_KEY = 'liquidityUsd';
/** Comfortably above `DEFAULT_PAY_DECISION_POLICY.minBondToPriceRatio` for any published `priceHbar`; matches `apps/watchdog`'s own default. */
export const DEFAULT_CHALLENGE_BOND_HBAR = 20;

export type DemoSessionDeps = {
  requesterNode: AssayNode;
  challengeNode: AssayNode;
  registry: RegistryPort;
  payments: PaymentsPort;
  goodProviderName: string;
  liarProviderName: string;
  /** Pushes one dashboard event. `main.ts` binds this to the `Screen`; `challengeNode`'s own filtering happens where it is built, not here (see the module doc comment). */
  push(event: LoopEvent): void;
  requestToken?: string;
  liarRequestToken?: string;
  claimKey?: string;
  challengeBondHbar?: number;
  /** Narrates state the dashboard doesn't: guard rejections, step transitions, fatal errors. `main.ts` wires this to `Screen.setStatus`. */
  onStatus?: (message: string) => void;
  /**
   * Called exactly once, right before this session calls `requesterNode.serve()`
   * (see the module doc comment on why `serve()`'s own unconditional payment
   * re-verification would otherwise downgrade the pay row this session
   * already finished narrating). `main.ts` wires this to stop forwarding
   * further mapped `'pay'` `LoopEvent`s from `requesterNode`'s `onLoopEvent`
   * for the rest of the process — safe permanently, since `pay` never
   * recurs after `serve` begins.
   */
  onPayFinalizing?: () => void;
};

/** Builds the demo's live step machine over the live (or fake, in tests) deps above. */
export function createDemoSession(deps: DemoSessionDeps): DemoSession {
  const requestToken = deps.requestToken ?? DEFAULT_REQUEST_TOKEN;
  const liarRequestToken = deps.liarRequestToken ?? DEFAULT_LIAR_TOKEN;
  const claimKey = deps.claimKey ?? DEFAULT_CLAIM_KEY;
  const challengeBondHbar = deps.challengeBondHbar ?? DEFAULT_CHALLENGE_BOND_HBAR;
  const onStatus = deps.onStatus ?? (() => {});

  let discovered: ProviderRecord | undefined;
  let confirmedTxId: string | undefined;

  return createStepMachine((ctx): StepRunners => {
    async function doDiscover(): Promise<void> {
      discovered = await deps.requesterNode.discover(deps.goodProviderName);
      // discover() already emitted a real 'discover' LoopEvent via the wired
      // onLoopEvent (mapped through createCoreEventMapper) before returning.
      ctx.advance('discover');
    }

    async function doPay(): Promise<void> {
      const startedAt = Date.now();
      const provider = discovered ?? (await deps.requesterNode.discover(deps.goodProviderName));
      const assessment = await deps.requesterNode.assess(deps.goodProviderName);
      const decision = evaluatePayDecision(assessment, DEFAULT_PAY_DECISION_POLICY);
      const trackRecord = assessment.signals.find((s) => s.key === 'trackRecord');

      if (!decision.pay) {
        deps.push({ step: 'pay', status: 'failed', summary: `declining to pay "${deps.goodProviderName}": ${decision.reason}` });
        ctx.onStatus('pay declined by policy — see the pay row for why. Nothing to retry until the reputation changes.');
        return; // Deliberately does not call ctx.advance(): see the module doc comment.
      }

      deps.push({
        step: 'pay',
        status: 'running',
        summary:
          `assessed ${deps.goodProviderName}: ${assessment.priceHbar} HBAR, score ${assessment.score}` +
          (trackRecord ? ` — ${trackRecord.detail}` : '') +
          ' — paying on Hedera testnet...',
      });

      const requestHash = hashRequest(provider.manifest.capabilityId, requestToken);
      const { txId } = await deps.payments.pay(provider.manifest.priceHbar, requestHash);
      deps.push({ step: 'pay', status: 'running', summary: `${provider.manifest.priceHbar} HBAR paid, tx ${txId}, confirming via mirror node...` });

      const confirmation = deps.payments.confirmPayment
        ? await deps.payments.confirmPayment({ txId, expectedAmountHbar: provider.manifest.priceHbar, expectedMemo: requestHash })
        : { confirmed: await deps.payments.confirm(txId) };

      if (!confirmation.confirmed) {
        deps.push({ step: 'pay', status: 'failed', summary: `payment ${txId} did not confirm` });
        ctx.onStatus('payment did not confirm — see the pay row for why.');
        return;
      }

      const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
      confirmedTxId = txId;
      deps.push({
        step: 'pay',
        status: 'ok',
        summary: `${provider.manifest.priceHbar} HBAR paid, confirmed via mirror node in ${elapsedS}s`,
        artifacts: [{ label: 'tx', value: txId }],
      });
      ctx.advance('pay');
    }

    async function doServe(): Promise<void> {
      if (!confirmedTxId) {
        ctx.onStatus('no confirmed payment on hand — press 2 (pay) first.');
        return;
      }
      const txId = confirmedTxId;
      confirmedTxId = undefined;
      const provider = discovered ?? (await deps.requesterNode.discover(deps.goodProviderName));
      // See the module doc comment: serve()'s own payment re-check is about
      // to fire a second, thinner 'pay' LoopEvent for the exact payment this
      // session already reported in full above.
      deps.onPayFinalizing?.();
      await deps.requesterNode.serve({
        provider: deps.goodProviderName,
        capabilityId: provider.manifest.capabilityId,
        request: requestToken,
        txId,
      });
      // serve() already emitted its own 'serve' + 'accept' LoopEvents.
      ctx.advance('serve');
    }

    async function doChallenge(): Promise<void> {
      // SPEC.md §11: "never mock the actual sponsor integration... label test
      // harnesses honestly". `challengeNode` runs `@assay/cap-rugscore`'s
      // `createLyingRugScoreProvider` (wired in `main.ts`), a declared test
      // harness that deliberately misreports one claim — everything else
      // about this step (the bond, the manifest write, the payment, the
      // verifier's re-derivation, the slash, the ENS write) is real. Said
      // here, once, on screen, rather than only in a doc comment nobody in
      // the audience reads.
      deps.push({
        step: 'challenge',
        status: 'running',
        summary:
          `preparing the challenge: re-bonding and serving "${deps.liarProviderName}" ` +
          '(a declared test harness that will misreport one claim, SPEC.md §11 — everything after this is real)...',
      });

      // Everything in this preamble (re-bonding, republishing the manifest,
      // paying) is raw port calls, not `AssayNode` methods — unlike
      // discover/serve/challenge/settle below, none of it emits its own
      // `LoopEvent` on failure (see the module doc comment on why the
      // preamble is silent even on the *happy* path). So this step is the
      // one place in this file that pushes its own `failed` event explicitly,
      // rather than relying on a wired `onLoopEvent` to have already done it.
      try {
        const current = await deps.registry.resolveProvider(deps.liarProviderName);
        const { bondRef } = await deps.payments.postBond(challengeBondHbar);
        const manifest: Manifest = { ...current.manifest, bondRef };
        await deps.registry.publishManifest(deps.liarProviderName, manifest);

        const requestHash = hashRequest(manifest.capabilityId, liarRequestToken);
        const { txId: payTxId } = await deps.payments.pay(manifest.priceHbar, requestHash);
        const job: Job = await deps.challengeNode.serve({
          provider: deps.liarProviderName,
          capabilityId: manifest.capabilityId,
          request: liarRequestToken,
          txId: payTxId,
        });

        const verdict = await deps.challengeNode.challenge(job.jobId, claimKey);
        await deps.challengeNode.settle(job.jobId, verdict);
        // challenge()/settle() already emitted their own (filtered) LoopEvents.
        ctx.advance('challenge');
      } catch (err) {
        deps.push({ step: 'challenge', status: 'failed', summary: `challenge failed: ${(err as Error).message}` });
        throw err;
      }
    }

    return { discover: doDiscover, pay: doPay, serve: doServe, challenge: doChallenge };
  }, onStatus);
}

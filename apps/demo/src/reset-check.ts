/**
 * The "visible reset check" issue #86 asks for: refuse to start rather than
 * fail halfway through act one (issue #64). `packages/registry/scripts/reset-demo-state.ts`
 * writes the good provider's opening reputation to a state that is
 * deliberately worth paying for; if a rehearsal or a real challenge has
 * since slashed it and nobody re-ran the reset script, the live agent (or,
 * here, this app's own pay step) correctly declines, and the demo's opening
 * beat cannot happen.
 *
 * Rather than hardcoding the reset script's exact target numbers here (which
 * would drift the moment `packages/registry/scripts/demo-state.ts` changes,
 * and which this package cannot import anyway -- `@assay/registry`'s
 * `package.json` only exports `"."`, and `scripts/` is not part of that
 * public surface), this asks the *same question* the live pay step is about
 * to ask for real: `assessProvider` + `evaluatePayDecision` against
 * `AssayNode.assess()`'s live read. If that would decline, the reset has not
 * run (or the demo's opening state has been damaged since), and this says so
 * with a concrete, actionable message instead of letting the presenter
 * discover it mid-narration when the "pay" key silently declines.
 */

import { evaluatePayDecision, type AssayNode, type ProviderAssessment } from '@assay/core';

export type ReadinessCheck =
  | { ready: true; assessment: ProviderAssessment }
  | { ready: false; assessment: ProviderAssessment; reason: string };

/**
 * Reads `providerName`'s live reputation and checks it against the same
 * pay-decision policy the demo's own pay step applies (`@assay/core`'s
 * `DEFAULT_PAY_DECISION_POLICY` — the session does not override it, so this
 * check uses exactly what the pay step will use). Real network read, no
 * fabricated numbers: `ready: false`'s `reason` is built from the actual
 * live assessment, not a canned string.
 *
 * Whatever `node.assess()` throws (e.g. `MissingRecordError` if the name was
 * never registered at all) propagates as-is: that is as clear a "the demo
 * cannot start" signal as a failed policy check, and wrapping it would only
 * hide which of the two happened.
 */
export async function checkDemoReadiness(node: Pick<AssayNode, 'assess'>, providerName: string): Promise<ReadinessCheck> {
  const assessment = await node.assess(providerName);
  const decision = evaluatePayDecision(assessment);

  if (decision.pay) {
    return { ready: true, assessment };
  }

  return {
    ready: false,
    assessment,
    reason:
      `"${providerName}"'s live reputation would make the demo's own pay step decline: ${decision.reason} ` +
      'Run `pnpm --filter @assay/registry exec tsx scripts/reset-demo-state.ts` before starting this demo ' +
      '(see docs/demo-run-sheet.md), then retry.',
  };
}

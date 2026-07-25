/**
 * ⚠️ TEST HARNESS — NOT A REAL PROVIDER (SPEC.md §11).
 *
 * `createLyingRugScoreProvider` runs the real `createRugScoreCapability`'s
 * `run()` against whatever `GraphPort` it is given (the real `@assay/graph`
 * adapter included), then deliberately corrupts exactly one claim before
 * returning it. It exists to prove `verify()` catches a lie, and it is the
 * demo's "provider bugiardo" twist (SPEC.md §10): the demo declares this
 * harness on stage, the same way it declares the watchdog's challenge
 * timing as scripted. Never register this in place of
 * `createRugScoreCapability` outside a test or a declared demo swap.
 *
 * It lives under `test-support/` (obviously test-only by path) but is
 * re-exported from the package's public entry point so `apps/watchdog`
 * (#28) can import it as `@assay/cap-rugscore`'s declared lying-provider
 * fixture, without reaching into this package's internals.
 */
import type { Capability, Claim } from '@assay/core';
import { createRugScoreCapability, type RugScoreDeps, type RugScoreRequest, type RugScoreResult } from '../rugscore.js';

export type LyingRugScoreOptions = {
  /** Which claim key to corrupt. Defaults to `'liquidityUsd'`. */
  claimKey?: string;
  /**
   * Computes the tampered value from the honest one. Defaults to inflating
   * a numeric claim by a large, fixed-plus-proportional amount, so the lie
   * is never accidentally within tolerance regardless of the honest value's
   * own magnitude (a token near $0 liquidity and a token near $1M liquidity
   * both end up reported as wildly, obviously more liquid than they are).
   */
  tamper?: (honestValue: unknown) => unknown;
  /**
   * Overrides the capability's own `id`. Defaults to `honest.id` (the same
   * `'rugscore'` id `createRugScoreCapability` registers under), which is
   * exactly right for a single-node build (`apps/watchdog`'s live-node.ts,
   * `apps/demo`'s live-node.ts: one node per mode, so no collision).
   *
   * A node that registers *both* the honest and the lying capability in the
   * same `CapabilityRegistry` (issue #93/#94: the scenic runner's live MCP
   * server needs a genuinely servable lie behind `liar.<parent>`, not a
   * hypothetical one) cannot do that with two capabilities sharing one id --
   * `createCapabilityRegistry.register` keys purely on `capability.id`, and a
   * second `register()` under the same id throws `DuplicateCapabilityError`.
   * Passing e.g. `{ id: 'rugscore.v2' }` here, and republishing
   * `liar.<parent>`'s manifest with that same `capabilityId`, is what makes
   * `liar.<parent>` dispatch to *this* capability instead of colliding with
   * the honest one -- see `apps/mcp/src/index.ts` and
   * `packages/registry/scripts/reset-demo-state.ts`.
   */
  id?: string;
};

const DEFAULT_TAMPER = (honestValue: unknown): unknown =>
  typeof honestValue === 'number' ? honestValue + Math.max(Math.abs(honestValue) * 10, 1_000_000) : honestValue;

/**
 * Builds a `Capability` whose `run()` tampers one claim from an otherwise
 * real result, and whose `verify()` delegates to the real, honest verifier
 * (a lying *provider* corrupts what it serves; it does not get a different,
 * also-dishonest verifier — the whole point is that the real verifier, run
 * by anyone, catches it).
 */
export function createLyingRugScoreProvider(
  deps: RugScoreDeps,
  options: LyingRugScoreOptions = {},
): Capability<RugScoreRequest, RugScoreResult> {
  const honest = createRugScoreCapability(deps);
  const claimKey = options.claimKey ?? 'liquidityUsd';
  const tamper = options.tamper ?? DEFAULT_TAMPER;

  return {
    id: options.id ?? honest.id,

    async run(token) {
      const { result, claims } = await honest.run(token);
      const tamperedClaims: Claim[] = claims.map((claim) =>
        claim.k === claimKey ? { ...claim, v: tamper(claim.v) } : claim,
      );
      return { result, claims: tamperedClaims };
    },

    verify: honest.verify,
  };
}

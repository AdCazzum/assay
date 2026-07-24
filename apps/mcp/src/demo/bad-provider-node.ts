/**
 * A declared test double (issue #24) standing in for a second, badly-reputed
 * provider under the same capability name, `"rugscore.assay.eth"`.
 *
 * Why this exists: SPEC.md §16 risk 5 requires proving the requester agent's
 * pay/decline call is *genuine reasoning*, not a hardcoded `if`, by giving
 * the exact same prompt to the exact same agent code against a good provider
 * and a bad one and showing it decide differently. The "good" leg is real:
 * `rugscore.assay.eth` is a live ENS record on Sepolia (see `../index.ts`'s
 * `buildLiveNodeFromEnv`). There is, as of this writing, no second live ENS
 * registration with a bad track record to resolve for the other leg —
 * creating one needs a brand-new subname with its own resolver assigned
 * first (see `packages/registry/scripts/smoke.ts`'s prerequisite note), which
 * is `packages/registry`'s surface, not this app's, and cannot be done
 * headlessly here (no browser, no GUI on this box). Rather than fake that
 * ENS read, this file is an honestly-declared fixture: `discover` and
 * `payAndCall` on it never touch Sepolia, Hedera, or The Graph, they return a
 * fabricated `ProviderRecord` with a genuinely bad track record. Everything
 * downstream of that record IS real production logic: `assessProvider` and
 * `evaluatePayDecision` are `@assay/core`'s actual, unmodified functions, so
 * the reasoning material and the policy floor the agent sees are the same
 * code path a live bad provider would produce, only the input data is
 * staged. Never presented as a live resolution: every string here says so.
 */

import {
  assessProvider,
  evaluatePayDecision,
  PayDeclinedError,
  type Job,
  type Manifest,
  type ProviderRecord,
  type Reputation,
} from '@assay/core';
import type { AssayNodePort, DiscoverResult } from '../node-port.js';

/**
 * Same name as the real live provider on purpose: the point of the demo is
 * that the requester agent gets the identical prompt and the identical
 * capability name both times, and only the reputation data behind that name
 * differs (exactly as two real counterparties in the protocol would differ).
 * See `apps/mcp/agent/README.md` for the full disclosure.
 */
export const BAD_PROVIDER_NAME = 'rugscore.assay.eth';

const BAD_MANIFEST: Manifest = {
  capabilityId: 'rugscore',
  description: 'Rug-pull risk score for an ERC-20 token, derived from The Graph Token API signals.',
  priceHbar: 5,
  endpoint: 'http://localhost:8787/serve',
  bondRef: 'demo-bad-provider-bond',
  verifierHash: '0xdemo-bad-provider',
};

/**
 * Fabricated on purpose (see module doc comment): a third of this provider's
 * jobs were slashed, and its bond is only as big as a single call's price.
 * Chosen to clear `DEFAULT_PAY_DECISION_POLICY`'s thresholds
 * (`maxSlashRatio: 0.15`, `minBondToPriceRatio: 2`) by a wide margin, so the
 * decline is not a hairline judgment call: a provider this shakily reputed
 * is a decline under both `assessProvider`'s plain reading and the policy
 * floor, and the agent is expected to say so itself before ever attempting
 * to pay.
 */
const BAD_REPUTATION: Reputation = {
  score: 20,
  jobs: 12,
  slashes: 4,
  bondHbar: 5,
};

export const BAD_PROVIDER_RECORD: ProviderRecord = {
  name: BAD_PROVIDER_NAME,
  manifest: BAD_MANIFEST,
  reputation: BAD_REPUTATION,
};

/** Thrown for anything this fixture does not model; see the module doc comment for why. */
export class DemoFixtureNotSupportedError extends Error {
  constructor(detail: string) {
    super(
      `This is the declared bad-provider FIXTURE server for issue #24's decline demo (see ` +
        `apps/mcp/agent/README.md), not a live node: ${detail}`,
    );
    this.name = 'DemoFixtureNotSupportedError';
  }
}

function checkName(capabilityId: string): void {
  if (capabilityId !== BAD_PROVIDER_NAME) {
    throw new DemoFixtureNotSupportedError(
      `it only knows one fabricated provider, "${BAD_PROVIDER_NAME}"; it stands in for a single ` +
        `badly-reputed counterparty, not a real registry, and cannot resolve "${capabilityId}".`,
    );
  }
}

/**
 * Builds the fixture `AssayNodePort` for the decline leg of the demo.
 * `discover` and `payAndCall`'s decline path are real `@assay/core` logic
 * over staged data (see module doc comment); `challenge` and `rate` are out
 * of scope for this fixture (nothing is ever paid or served here) and throw
 * `DemoFixtureNotSupportedError` rather than fabricate a job.
 */
export function createBadProviderDemoNode(): AssayNodePort {
  return {
    async discover(capabilityId: string): Promise<DiscoverResult> {
      checkName(capabilityId);
      return { provider: BAD_PROVIDER_RECORD, assessment: assessProvider(BAD_PROVIDER_RECORD) };
    },

    async payAndCall(capabilityId: string, _request: unknown, force = false): Promise<Job> {
      checkName(capabilityId);
      const assessment = assessProvider(BAD_PROVIDER_RECORD);
      if (!force) {
        const decision = evaluatePayDecision(assessment);
        if (!decision.pay) {
          throw new PayDeclinedError(BAD_PROVIDER_NAME, assessment, decision.reason, decision.violations);
        }
      }
      // Reached only if the policy somehow passed, or the caller forced past
      // it: this fixture has no real Hedera rail and no real capability
      // behind it, so it refuses rather than fabricate a paid job.
      throw new DemoFixtureNotSupportedError(
        'it has no real payment rail or capability behind it, so it cannot actually serve a job. ' +
          'It exists only to demonstrate the decline path for a badly-reputed provider.',
      );
    },

    async challenge(_jobId: string, _claimKey: string): Promise<Job> {
      throw new DemoFixtureNotSupportedError('no job was ever served here, so there is nothing to challenge.');
    },

    async rate(_jobId: string, _satisfied: boolean, _comment?: string): Promise<Job> {
      throw new DemoFixtureNotSupportedError('no job was ever served here, so there is nothing to rate.');
    },
  };
}

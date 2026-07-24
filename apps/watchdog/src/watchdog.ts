/**
 * @assay/watchdog's core logic (issue #28, SPEC.md §7 steps 6-8, §10). This
 * is the demo climax: challenge one claim of a served job, let the
 * capability's own `verify()` decide, and drive `settle()` on whatever
 * verdict comes back.
 *
 * The one property this file is built to prove (per the issue): **the
 * watchdog does not know in advance whether the claim is true or false.**
 * `challengeAndSettle()` below never branches on which provider served the
 * job or what claim value it saw; it always calls `node.challenge()`, always
 * reads `verdict.valid` off the *return value*, and only then decides
 * whether to narrate a slash or a vindication. Point it at an honest result
 * and the challenge fails (reputation rises, nothing is slashed); point it
 * at the declared lying-provider harness and the challenge succeeds (bond
 * slashed, reputation drops). Same function, either outcome, decided by the
 * verifier alone.
 */

import type { AssayNode, Job, Reputation, Verdict } from '@assay/core';
import type { SlashRecord } from './slash-observer.js';

/** One line of narration. Defaults to a no-op so tests can run silently; `index.ts` wires this to `console.log`. */
export type Printer = (line: string) => void;

export type ChallengeAndSettleDeps = {
  /** A real `AssayNode` (live adapters) or one built over `fakes.ts`'s test doubles: this file only calls the public `AssayNode` surface. */
  node: Pick<AssayNode, 'jobs' | 'discover' | 'challenge' | 'settle'>;
  print?: Printer;
  /**
   * Recovers the txId of the `payments.slash()` call `node.settle()` makes
   * internally, if any (see `slash-observer.ts`). Omit to still get a
   * correct settlement, just without a slash txId/HashScan line to print
   * (e.g. if the caller didn't wire an `ObservedPayments`).
   */
  getLastSlash?: () => SlashRecord | undefined;
  /** e.g. `https://hashscan.io/testnet`. Omit to skip the HashScan line even when a slash txId is known. */
  hashscanBaseUrl?: string;
};

export type ChallengeAndSettleResult = {
  jobId: string;
  claimKey: string;
  job: Job;
  verdict: Verdict;
  reputationBefore: Reputation;
  reputationAfter: Reputation;
  slash?: SlashRecord;
};

function formatReputation(rep: Reputation): string {
  return `score ${rep.score}, jobs ${rep.jobs}, slashes ${rep.slashes}`;
}

/**
 * Challenges `claimKey` on `jobId`, then settles on whatever verdict comes
 * back (SPEC.md §7 steps 6-7). Narrates every step to `deps.print` with the
 * real, independently-checkable artifacts a viewer can go verify themselves:
 * the claimed value, the verdict's own account of what The Graph reports at
 * that block (`Verdict.reason`, produced by the capability's `verify()` —
 * see `@assay/cap-rugscore`'s `rugscore.ts`), the slash HashScan link when
 * there is one, and the provider's ENS reputation before and after.
 *
 * Propagates whatever `node.challenge()`/`node.settle()` throw (e.g.
 * `JobNotChallengeableError`, `UnknownClaimError`, `ReputationUpdateFailedError`)
 * without wrapping them: the caller (or its own error handling) sees the
 * same named errors `@assay/core` documents.
 */
export async function challengeAndSettle(
  jobId: string,
  claimKey: string,
  deps: ChallengeAndSettleDeps,
): Promise<ChallengeAndSettleResult> {
  const { node } = deps;
  const print = deps.print ?? (() => {});

  const job = node.jobs.get(jobId);
  const claim = job.claims.find((c) => c.k === claimKey);

  print(
    `Challenge  job "${jobId}" on "${job.provider}": disputing claim "${claimKey}"` +
      (claim ? ` = ${JSON.stringify(claim.v)} (claimed at block ${claim.atBlock})` : ' (unknown claim key)'),
  );

  const providerBefore = await node.discover(job.provider);
  print(`  reputation before: ${formatReputation(providerBefore.reputation)}`);

  // The one call that decides everything below. This function never looks
  // at `claim.v` itself to guess the outcome; it takes whatever the
  // capability's own `verify()` returns through `node.challenge()`.
  const verdict = await node.challenge(jobId, claimKey);

  if (verdict.valid) {
    print('Verify     verdict: VALID — the claim held up against The Graph at the same block. Challenge fails.');
  } else {
    print(
      `Verify     verdict: FALSE — claim "${verdict.badClaim ?? claimKey}" did not hold up.` +
        (verdict.reason ? ` ${verdict.reason}` : ''),
    );
  }

  const settled = await node.settle(jobId, verdict);

  let slash: SlashRecord | undefined;
  if (verdict.valid) {
    print('Slash      none: the provider is vindicated, no bond is touched.');
  } else {
    slash = deps.getLastSlash?.();
    if (slash) {
      print(`Slash      bond "${slash.bondRef}" slashed to "${slash.toChallenger}" (tx ${slash.txId})`);
      if (deps.hashscanBaseUrl) {
        print(`  hashscan: ${deps.hashscanBaseUrl}/transaction/${slash.txId}`);
      }
    } else {
      print('Slash      the bond was slashed, but no txId was observed (no ObservedPayments wired in).');
    }
  }

  const providerAfter = await node.discover(job.provider);
  print(
    `Reputation ${job.provider}: ${formatReputation(providerBefore.reputation)} -> ${formatReputation(providerAfter.reputation)}`,
  );

  return {
    jobId,
    claimKey,
    job: settled,
    verdict,
    reputationBefore: providerBefore.reputation,
    reputationAfter: providerAfter.reputation,
    slash,
  };
}

/**
 * Printed once, up front, every time this app runs (issue #28, SPEC.md §11).
 * A judge who is told a claim is staged reads it as rigour; one who
 * discovers it themselves reads it as deception. This is the honest
 * declaration `index.ts` prints before doing anything else.
 */
export const STAGED_DISCLOSURE: readonly string[] = [
  'STAGED FOR THIS DEMO (SPEC.md §11, disclosed on purpose):',
  '  - the "lying provider" is @assay/cap-rugscore\'s createLyingRugScoreProvider, a deliberately',
  '    tampered test harness, not a real dishonest agent.',
  '  - this watchdog\'s challenge is scripted for timing: a real, unscripted watchdog would decide',
  '    on its own when to challenge, this one is told which job/claim to look at.',
  '  - everything else below is real: the challenge, the verifier re-deriving the claim from The',
  '    Graph at the exact block it was stamped at, the Hedera slash transaction, and the ENS',
  '    reputation write.',
];

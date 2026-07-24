/**
 * Thrown by `verify()` when a claim cannot be checked at all: the port
 * failed to answer at the claim's `atBlock` (rate limit, gateway hiccup, a
 * block briefly out of the subgraph's indexed range, ...), or the claim's
 * key names a signal this verifier does not know how to re-derive.
 *
 * SPEC.md §12 requires distinguishing "cannot verify" from "verified
 * false": a `Verdict` with `valid: false` means "we checked, and the
 * provider lied", and a real settlement path (`challenge()`/`settle()`,
 * #26/#27) would slash real money on it. An infrastructure failure is not
 * that; conflating the two would slash an honest provider for a Graph
 * outage. This is a thrown error, not a `Verdict`, specifically so it can
 * never be mistaken for one at the call site.
 */
export class ClaimVerificationUnavailableError extends Error {
  readonly claimKey: string;
  readonly atBlock: number;

  constructor(claimKey: string, atBlock: number, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Cannot verify claim "${claimKey}" at block ${atBlock}: ${detail}. ` +
        'This is an infrastructure failure, not evidence the claim is false — do not slash on it.',
      { cause },
    );
    this.name = 'ClaimVerificationUnavailableError';
    this.claimKey = claimKey;
    this.atBlock = atBlock;
  }
}

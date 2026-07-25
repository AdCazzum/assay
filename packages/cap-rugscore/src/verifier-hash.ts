/**
 * A real commitment to the verifier, for the manifest's `verifierHash`.
 *
 * SPEC.md §5 defines `verifierHash` as part of the capability manifest, and the
 * reason it exists is that a requester accepting a result optimistically is
 * trusting a specific verifier to adjudicate it later. If the provider can
 * swap that verifier out afterwards, the trust is worthless: it could publish
 * a strict verifier, take payment, then quietly relax the tolerances so no
 * challenge ever succeeds.
 *
 * So the hash has to cover **what determines a verdict**, and nothing else:
 *
 * - `rugscore.ts`, which is `verify()` itself, including the rule that each
 *   claim is re-derived at its own `atBlock`.
 * - `tolerances.ts`, because a tolerance change silently changes verdicts. A
 *   commitment that ignored it would be trivially defeatable, which is the
 *   whole failure mode this field exists to prevent.
 *
 * Deliberately **not** covered: `scoring.ts`. The score is an opinion the
 * provider offers and is not adjudicated by anything; only the factual claims
 * are. Including it would make the hash churn on tuning that cannot affect a
 * verdict.
 *
 * This reads the source at runtime, which works because nothing here is
 * emitted (see AGENTS.md "Build tooling": packages resolve to source and run
 * under tsx). That is also what makes it honest: anyone can run
 * `sha256sum` over the same two files and get the same answer.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The files whose contents decide whether a claim verifies. Order is fixed
 * because it is part of the hash.
 */
export const VERIFIER_SOURCE_FILES = ['rugscore.ts', 'tolerances.ts'] as const;

/**
 * Computes the verifier commitment as `sha256:<hex>`.
 *
 * Each file is fed in as `<name>\n<length>\n<contents>`. The name and byte
 * length are included so the digest cannot collide by moving bytes across the
 * boundary between two files.
 */
export function computeVerifierHash(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const hash = createHash('sha256');

  for (const file of VERIFIER_SOURCE_FILES) {
    const contents = readFileSync(path.join(dir, file));
    hash.update(`${file}\n${contents.byteLength}\n`);
    hash.update(contents);
  }

  return `sha256:${hash.digest('hex')}`;
}

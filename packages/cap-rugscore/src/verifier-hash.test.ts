import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { computeVerifierHash, VERIFIER_SOURCE_FILES } from './verifier-hash.js';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

describe('computeVerifierHash', () => {
  it('returns a sha256 commitment in a form a manifest can carry', () => {
    expect(computeVerifierHash()).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is stable across calls, so a manifest republish does not churn it', () => {
    expect(computeVerifierHash()).toBe(computeVerifierHash());
  });

  it('covers verify() and the tolerances, because both decide a verdict', () => {
    // Tolerances matter as much as the comparison logic: relaxing them changes
    // verdicts, so a commitment that ignored them would be trivially defeated.
    expect([...VERIFIER_SOURCE_FILES]).toEqual(['rugscore.ts', 'tolerances.ts']);
  });

  it('does not cover scoring, which no verdict depends on', () => {
    expect(VERIFIER_SOURCE_FILES).not.toContain('scoring.ts');
  });

  it('is reproducible by hand, so the commitment is checkable by anyone', () => {
    // Whoever wants to audit the published verifierHash must be able to
    // re-derive it from the source files without trusting this code.
    const expected = createHash('sha256');
    for (const file of VERIFIER_SOURCE_FILES) {
      const contents = readFileSync(path.join(srcDir, file));
      expected.update(`${file}\n${contents.byteLength}\n`);
      expected.update(contents);
    }
    expect(computeVerifierHash()).toBe(`sha256:${expected.digest('hex')}`);
  });

  it('changes when a covered file changes', () => {
    // Simulated rather than mutating real source: feed the same construction
    // one altered byte and confirm the digest moves.
    const digestOf = (mutate: (name: string, buf: Buffer) => Buffer): string => {
      const h = createHash('sha256');
      for (const file of VERIFIER_SOURCE_FILES) {
        const contents = mutate(file, readFileSync(path.join(srcDir, file)));
        h.update(`${file}\n${contents.byteLength}\n`);
        h.update(contents);
      }
      return `sha256:${h.digest('hex')}`;
    };

    const unchanged = digestOf((_n, b) => b);
    const tampered = digestOf((name, b) =>
      name === 'tolerances.ts' ? Buffer.concat([b, Buffer.from('// relaxed\n')]) : b,
    );

    expect(unchanged).toBe(computeVerifierHash());
    expect(tampered).not.toBe(unchanged);
  });
});

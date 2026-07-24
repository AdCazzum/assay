import { describe, expect, it } from 'vitest';
import { CLEAN_TOKEN_SIGNALS, RUG_TOKEN_SIGNALS } from '../fixtures.js';
import { createRugScoreCapability } from '../rugscore.js';
import { FakeGraphPort } from './fake-graph-port.js';
import { createLyingRugScoreProvider } from './lying-provider.js';

const CLEAN_TOKEN = '0xclean';
const RUG_TOKEN = '0xrug';

describe('createLyingRugScoreProvider (test harness, SPEC.md §11)', () => {
  it('exposes the same capability id as the honest capability', () => {
    const graph = new FakeGraphPort(1, {});
    const lying = createLyingRugScoreProvider({ graph });
    expect(lying.id).toBe('rugscore');
  });

  it('by default tampers liquidityUsd, and the honest verifier catches it', async () => {
    const atBlock = 9_000;
    const graph = new FakeGraphPort(atBlock, { [RUG_TOKEN]: { ...RUG_TOKEN_SIGNALS, atBlock } });
    const lying = createLyingRugScoreProvider({ graph });
    const honestVerifier = createRugScoreCapability({ graph });

    const { result, claims } = await lying.run(RUG_TOKEN);
    const verdict = await honestVerifier.verify(RUG_TOKEN, result, claims);

    expect(verdict.valid).toBe(false);
    expect(verdict.badClaim).toBe('liquidityUsd');
  });

  it('tampers only the targeted claim; every other claim stays honest', async () => {
    const atBlock = 9_001;
    const graph = new FakeGraphPort(atBlock, { [RUG_TOKEN]: { ...RUG_TOKEN_SIGNALS, atBlock } });
    const honest = createRugScoreCapability({ graph });
    const lying = createLyingRugScoreProvider({ graph });

    const honestRun = await honest.run(RUG_TOKEN);
    const lyingRun = await lying.run(RUG_TOKEN);

    const untouchedKeys = honestRun.claims.map((c) => c.k).filter((k) => k !== 'liquidityUsd');
    for (const key of untouchedKeys) {
      const honestClaim = honestRun.claims.find((c) => c.k === key);
      const lyingClaim = lyingRun.claims.find((c) => c.k === key);
      expect(lyingClaim?.v).toEqual(honestClaim?.v);
    }
    const honestLiquidity = honestRun.claims.find((c) => c.k === 'liquidityUsd')?.v;
    const lyingLiquidity = lyingRun.claims.find((c) => c.k === 'liquidityUsd')?.v;
    expect(lyingLiquidity).not.toEqual(honestLiquidity);
  });

  it('supports tampering a different claim key via options, and the verifier still names exactly that one', async () => {
    const atBlock = 9_002;
    const graph = new FakeGraphPort(atBlock, { [RUG_TOKEN]: { ...RUG_TOKEN_SIGNALS, atBlock } });
    const lying = createLyingRugScoreProvider(
      { graph },
      { claimKey: 'topPoolConcentrationPct', tamper: () => 1 },
    );
    const honestVerifier = createRugScoreCapability({ graph });

    const { result, claims } = await lying.run(RUG_TOKEN);
    const verdict = await honestVerifier.verify(RUG_TOKEN, result, claims);

    expect(verdict.valid).toBe(false);
    expect(verdict.badClaim).toBe('topPoolConcentrationPct');
  });

  it('the honest provider (a real capability, not this harness) verifies clean on both fixtures', async () => {
    const atBlock = 9_003;
    const graph = new FakeGraphPort(atBlock, {
      [CLEAN_TOKEN]: { ...CLEAN_TOKEN_SIGNALS, atBlock },
      [RUG_TOKEN]: { ...RUG_TOKEN_SIGNALS, atBlock },
    });
    const honest = createRugScoreCapability({ graph });

    const cleanRun = await honest.run(CLEAN_TOKEN);
    const rugRun = await honest.run(RUG_TOKEN);

    expect(await honest.verify(CLEAN_TOKEN, cleanRun.result, cleanRun.claims)).toEqual({ valid: true });
    expect(await honest.verify(RUG_TOKEN, rugRun.result, rugRun.claims)).toEqual({ valid: true });
  });
});

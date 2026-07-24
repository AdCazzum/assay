import { describe, expect, it } from 'vitest';
import { CLEAN_TOKEN_SIGNALS, RUG_TOKEN_SIGNALS } from './fixtures.js';
import { createRugScoreCapability } from './rugscore.js';
import { FakeGraphPort } from './test-support/fake-graph-port.js';

const CLEAN_TOKEN = '0xclean';
const RUG_TOKEN = '0xrug';

describe('createRugScoreCapability().run', () => {
  it('scores a clean token low', async () => {
    const graph = new FakeGraphPort(12_345, {
      [CLEAN_TOKEN]: { ...CLEAN_TOKEN_SIGNALS, atBlock: 12_345 },
    });
    const capability = createRugScoreCapability({ graph });

    const { result } = await capability.run(CLEAN_TOKEN);

    expect(result.score).toBeLessThan(30);
  });

  it('scores a rug token high', async () => {
    const graph = new FakeGraphPort(12_345, {
      [RUG_TOKEN]: { ...RUG_TOKEN_SIGNALS, atBlock: 12_345 },
    });
    const capability = createRugScoreCapability({ graph });

    const { result } = await capability.run(RUG_TOKEN);

    expect(result.score).toBeGreaterThan(70);
  });

  it('gets the latest block once and queries signals at exactly that block', async () => {
    const graph = new FakeGraphPort(999, {
      [RUG_TOKEN]: { ...RUG_TOKEN_SIGNALS, atBlock: 999 },
    });
    const capability = createRugScoreCapability({ graph });

    await capability.run(RUG_TOKEN);

    expect(graph.calls).toEqual([{ token: RUG_TOKEN, atBlock: 999 }]);
  });

  it('returns every SPEC.md §6 claim, all stamped with the same atBlock', async () => {
    const graph = new FakeGraphPort(555, {
      [RUG_TOKEN]: { ...RUG_TOKEN_SIGNALS, atBlock: 555 },
    });
    const capability = createRugScoreCapability({ graph });

    const { claims } = await capability.run(RUG_TOKEN);

    const keys = claims.map((c) => c.k).sort();
    expect(keys).toEqual(['ageBlocks', 'hasActiveMintRole', 'liquidityUsd', 'top10Pct'].sort());
    for (const claim of claims) {
      expect(claim.atBlock).toBe(555);
    }
    // every claim shares literally the same block, not just the same value
    const distinctBlocks = new Set(claims.map((c) => c.atBlock));
    expect(distinctBlocks.size).toBe(1);
  });

  it('carries the claim values straight from the queried signals', async () => {
    const graph = new FakeGraphPort(1, {
      [RUG_TOKEN]: { ...RUG_TOKEN_SIGNALS, atBlock: 1 },
    });
    const capability = createRugScoreCapability({ graph });

    const { claims } = await capability.run(RUG_TOKEN);

    const byKey = Object.fromEntries(claims.map((c) => [c.k, c.v]));
    expect(byKey).toEqual({
      top10Pct: RUG_TOKEN_SIGNALS.top10Pct,
      liquidityUsd: RUG_TOKEN_SIGNALS.liquidityUsd,
      ageBlocks: RUG_TOKEN_SIGNALS.ageBlocks,
      hasActiveMintRole: RUG_TOKEN_SIGNALS.hasActiveMintRole,
    });
  });

  it('stamps claims with the block the port actually returned data for, not just the block requested', async () => {
    // Simulates the port's own response drifting from the requested block
    // (e.g. mirroring lag). run() must trust what the signals say they were
    // measured at, since that is what the verifier in #12 will re-query.
    const requestedBlock = 200;
    const actualDataBlock = 199;
    const graph = new FakeGraphPort(requestedBlock, {
      [RUG_TOKEN]: { ...RUG_TOKEN_SIGNALS, atBlock: actualDataBlock },
    });
    const capability = createRugScoreCapability({ graph });

    const { claims } = await capability.run(RUG_TOKEN);

    expect(graph.calls).toEqual([{ token: RUG_TOKEN, atBlock: requestedBlock }]);
    for (const claim of claims) {
      expect(claim.atBlock).toBe(actualDataBlock);
    }
  });

  it('exposes the capability id "rugscore"', () => {
    const graph = new FakeGraphPort(1, {});
    const capability = createRugScoreCapability({ graph });
    expect(capability.id).toBe('rugscore');
  });
});

describe('createRugScoreCapability().verify', () => {
  it('is out of scope for this issue and throws rather than lying', async () => {
    const graph = new FakeGraphPort(1, {});
    const capability = createRugScoreCapability({ graph });

    await expect(capability.verify('0xtoken', { score: 0 }, [])).rejects.toThrow('#12');
  });
});

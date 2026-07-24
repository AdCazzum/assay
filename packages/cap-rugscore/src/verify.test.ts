import { describe, expect, it } from 'vitest';
import type { Claim } from '@assay/core';
import { CLEAN_TOKEN_SIGNALS, RUG_TOKEN_SIGNALS } from './fixtures.js';
import { createRugScoreCapability } from './rugscore.js';
import { ClaimVerificationUnavailableError } from './errors.js';
import { FailingGraphPort, FakeGraphPort } from './test-support/fake-graph-port.js';

const CLEAN_TOKEN = '0xclean';
const RUG_TOKEN = '0xrug';

describe('createRugScoreCapability().verify', () => {
  it('returns {valid: true} for an honest clean-token result', async () => {
    const graph = new FakeGraphPort(1_000, { [CLEAN_TOKEN]: { ...CLEAN_TOKEN_SIGNALS, atBlock: 1_000 } });
    const capability = createRugScoreCapability({ graph });

    const { result, claims } = await capability.run(CLEAN_TOKEN);
    const verdict = await capability.verify(CLEAN_TOKEN, result, claims);

    expect(verdict).toEqual({ valid: true });
  });

  it('returns {valid: true} for an honest rug-token result', async () => {
    const graph = new FakeGraphPort(2_000, { [RUG_TOKEN]: { ...RUG_TOKEN_SIGNALS, atBlock: 2_000 } });
    const capability = createRugScoreCapability({ graph });

    const { result, claims } = await capability.run(RUG_TOKEN);
    const verdict = await capability.verify(RUG_TOKEN, result, claims);

    expect(verdict).toEqual({ valid: true });
  });

  it('catches a single tampered claim and names it as badClaim', async () => {
    const graph = new FakeGraphPort(3_000, { [RUG_TOKEN]: { ...RUG_TOKEN_SIGNALS, atBlock: 3_000 } });
    const capability = createRugScoreCapability({ graph });

    const { result, claims } = await capability.run(RUG_TOKEN);
    const tampered: Claim[] = claims.map((c) => (c.k === 'liquidityUsd' ? { ...c, v: 5_000_000 } : c));

    const verdict = await capability.verify(RUG_TOKEN, result, tampered);

    expect(verdict.valid).toBe(false);
    expect(verdict.badClaim).toBe('liquidityUsd');
  });

  it('names the first bad claim in claim order when more than one is wrong', async () => {
    const graph = new FakeGraphPort(3_001, { [RUG_TOKEN]: { ...RUG_TOKEN_SIGNALS, atBlock: 3_001 } });
    const capability = createRugScoreCapability({ graph });

    const { result, claims } = await capability.run(RUG_TOKEN);
    // Tamper txCount (index 2) and liquidityUsd (index 0); liquidityUsd comes
    // first in run()'s claim order, so it must be the one reported.
    const tampered: Claim[] = claims.map((c) => {
      if (c.k === 'liquidityUsd') return { ...c, v: 9_999_999 };
      if (c.k === 'txCount') return { ...c, v: 999_999 };
      return c;
    });

    const verdict = await capability.verify(RUG_TOKEN, result, tampered);

    expect(verdict.valid).toBe(false);
    expect(verdict.badClaim).toBe('liquidityUsd');
  });

  it('accepts a claim within the configured tolerance and rejects one past it', async () => {
    const atBlock = 4_000;
    const trueLiquidity = 50_000;
    const graph = new FakeGraphPort(atBlock, {
      [CLEAN_TOKEN]: { ...CLEAN_TOKEN_SIGNALS, liquidityUsd: trueLiquidity, atBlock },
    });
    // A capability with a wide, explicit tolerance for this one test, so the
    // "within tolerance" and "past tolerance" cases are both deterministic
    // and don't depend on the (much tighter) production default.
    const capability = createRugScoreCapability({
      graph,
      tolerances: { liquidityUsd: { absolute: 5, relative: 0 } },
    });

    const claimWithinTolerance: Claim = { k: 'liquidityUsd', v: trueLiquidity + 4, atBlock };
    const claimPastTolerance: Claim = { k: 'liquidityUsd', v: trueLiquidity + 6, atBlock };

    const okVerdict = await capability.verify(CLEAN_TOKEN, { score: 0 }, [claimWithinTolerance]);
    const badVerdict = await capability.verify(CLEAN_TOKEN, { score: 0 }, [claimPastTolerance]);

    expect(okVerdict.valid).toBe(true);
    expect(badVerdict.valid).toBe(false);
    expect(badVerdict.badClaim).toBe('liquidityUsd');
  });

  it('treats a claimed NaN ageBlocks (no pool observed) as matching a re-derived NaN', async () => {
    const atBlock = 5_000;
    const graph = new FakeGraphPort(atBlock, {
      [CLEAN_TOKEN]: { ...CLEAN_TOKEN_SIGNALS, ageBlocks: NaN, atBlock },
    });
    const capability = createRugScoreCapability({ graph });

    const claim: Claim = { k: 'ageBlocks', v: NaN, atBlock };
    const verdict = await capability.verify(CLEAN_TOKEN, { score: 0 }, [claim]);

    expect(verdict).toEqual({ valid: true });
  });

  it('catches a claimed ageBlocks when the re-derived value is actually NaN (no pool observed)', async () => {
    const atBlock = 5_001;
    const graph = new FakeGraphPort(atBlock, {
      [CLEAN_TOKEN]: { ...CLEAN_TOKEN_SIGNALS, ageBlocks: NaN, atBlock },
    });
    const capability = createRugScoreCapability({ graph });

    const claim: Claim = { k: 'ageBlocks', v: 12_345, atBlock };
    const verdict = await capability.verify(CLEAN_TOKEN, { score: 0 }, [claim]);

    expect(verdict.valid).toBe(false);
    expect(verdict.badClaim).toBe('ageBlocks');
  });

  it('does not slash an honest provider when the chain has advanced since serving: verify always queries the claim\'s own atBlock, never the current head', async () => {
    const servedAtBlock = 6_000;
    const advancedHeadBlock = 6_500;
    const honestSignals = { ...RUG_TOKEN_SIGNALS, atBlock: servedAtBlock };
    // Signals "as of the current head" are deliberately very different, so
    // if verify() ever queried the current head instead of the claim's own
    // atBlock, this test would fail loudly instead of passing by accident.
    const currentHeadSignals = { ...CLEAN_TOKEN_SIGNALS, atBlock: advancedHeadBlock };

    const graph = new FakeGraphPort(servedAtBlock, {
      [RUG_TOKEN]: (atBlock) => (atBlock === servedAtBlock ? honestSignals : currentHeadSignals),
    });
    const capability = createRugScoreCapability({ graph });

    const { result, claims } = await capability.run(RUG_TOKEN);

    // The chain moves on; a live requester's node would now report a later head.
    graph.setLatestBlock(advancedHeadBlock);

    const verdict = await capability.verify(RUG_TOKEN, result, claims);

    expect(verdict).toEqual({ valid: true });
    expect(graph.getLatestBlockCallCount).toBe(1); // only run()'s own call
    for (const call of graph.calls) {
      expect(call.atBlock).toBe(servedAtBlock);
    }
  });

  it('rejects with ClaimVerificationUnavailableError, not a false verdict, when the port cannot answer at the claim\'s block', async () => {
    const atBlock = 7_000;
    const graph = new FailingGraphPort(new Error('gateway rate limited (429)'));
    const capability = createRugScoreCapability({ graph });

    const claim: Claim = { k: 'liquidityUsd', v: 100, atBlock };

    await expect(capability.verify(RUG_TOKEN, { score: 0 }, [claim])).rejects.toBeInstanceOf(
      ClaimVerificationUnavailableError,
    );
  });

  it('rejects with ClaimVerificationUnavailableError for a claim key this verifier does not know how to re-derive, rather than calling it a lie', async () => {
    const atBlock = 7_001;
    const graph = new FakeGraphPort(atBlock, { [RUG_TOKEN]: { ...RUG_TOKEN_SIGNALS, atBlock } });
    const capability = createRugScoreCapability({ graph });

    const claim: Claim = { k: 'hasActiveMintRole', v: true, atBlock };

    await expect(capability.verify(RUG_TOKEN, { score: 0 }, [claim])).rejects.toBeInstanceOf(
      ClaimVerificationUnavailableError,
    );
  });

  it('queries getTokenSignals only once per distinct atBlock across all claims', async () => {
    const atBlock = 8_000;
    const graph = new FakeGraphPort(atBlock, { [RUG_TOKEN]: { ...RUG_TOKEN_SIGNALS, atBlock } });
    const capability = createRugScoreCapability({ graph });

    const { result, claims } = await capability.run(RUG_TOKEN);
    await capability.verify(RUG_TOKEN, result, claims);

    // run() made one call; verify() should make exactly one more (every
    // claim shares the same atBlock), not one per claim.
    expect(graph.calls.length).toBe(2);
  });
});

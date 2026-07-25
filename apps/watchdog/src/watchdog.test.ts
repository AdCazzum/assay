import { describe, expect, it } from 'vitest';
import { createAssayNode, createCapabilityRegistry, type Manifest } from '@assay/core';
import { createLyingRugScoreProvider, createRugScoreCapability, RUG_TOKEN_SIGNALS } from '@assay/cap-rugscore';
import { FakeGraphPort, FakePaymentsPort, FakeRegistryPort } from './fakes.js';
import { observeSlash } from './slash-observer.js';
import { challengeAndSettle } from './watchdog.js';

const PROVIDER_NAME = 'rugscore.assay.eth';
const TOKEN = '0xrug';
const AT_BLOCK = 21_050_900;
const CHALLENGER_ACCOUNT_ID = '0.0.999999';

const manifest: Manifest = {
  capabilityId: 'rugscore',
  description: 'Rug-pull risk score for an ERC-20 token, derived from The Graph Token API signals.',
  priceHbar: 5,
  endpoint: 'https://example.invalid/serve',
  bondRef: 'bond-seed',
  verifierHash: '0xseed',
};

/**
 * Builds a real `AssayNode` (real `@assay/core`, real `@assay/cap-rugscore`
 * capability — either the honest one or its declared lying-provider harness)
 * over this app's own fakes for `RegistryPort`/`PaymentsPort`/`GraphPort`, with
 * one already-served job ready to challenge. This is deliberately not a toy
 * echo capability: it exercises the actual verifier this app's `verify()`
 * step in the demo depends on.
 */
async function buildServedNode(capabilityMode: 'honest' | 'lying') {
  const registry = new FakeRegistryPort().seed(PROVIDER_NAME, {
    manifest,
    reputation: { score: 80, jobs: 3, slashes: 0, bondHbar: 50 },
  });
  const rawPayments = new FakePaymentsPort();
  const { payments, getLastSlash } = observeSlash(rawPayments);
  const graph = new FakeGraphPort(AT_BLOCK, { [TOKEN]: { ...RUG_TOKEN_SIGNALS, atBlock: AT_BLOCK } });

  const capabilities = createCapabilityRegistry();
  capabilities.register(
    capabilityMode === 'honest' ? createRugScoreCapability({ graph }) : createLyingRugScoreProvider({ graph }),
  );

  const node = createAssayNode({ registry, payments, graph, capabilities, challengerAccountId: CHALLENGER_ACCOUNT_ID });
  const { job } = await node.payAndCall(PROVIDER_NAME, 'rugscore', TOKEN);

  return { node, registry, payments: rawPayments, getLastSlash, job };
}

describe('challengeAndSettle', () => {
  it('does not know in advance whether a claim is true: an honest claim survives a challenge', async () => {
    const { node, registry, payments, getLastSlash, job } = await buildServedNode('honest');
    const lines: string[] = [];

    const result = await challengeAndSettle(job.jobId, 'liquidityUsd', {
      node,
      print: (line) => lines.push(line),
      getLastSlash,
      hashscanBaseUrl: 'https://hashscan.io/testnet',
    });

    expect(result.verdict).toEqual({ valid: true });
    expect(result.job.status).toBe('settled');
    expect(result.job.verdict).toEqual({ valid: true });

    // No money moved: the challenge failed, so nothing is slashed.
    expect(payments.slashCalls).toHaveLength(0);
    expect(getLastSlash()).toBeUndefined();

    // Reputation rose (challengeFailedScoreBonus), slashes untouched, jobs closed out.
    expect(registry.updateReputationCalls).toHaveLength(1);
    expect(result.reputationBefore).toEqual({ score: 80, jobs: 3, slashes: 0, bondHbar: 50 });
    expect(result.reputationAfter.score).toBeGreaterThan(result.reputationBefore.score);
    expect(result.reputationAfter.slashes).toBe(0);

    const output = lines.join('\n');
    expect(output).toContain('Challenge  job');
    expect(output).toContain('VALID');
    expect(output).toContain('Challenge fails');
    expect(output).toContain('Slash      none');
    expect(output).toContain('Reputation');
  });

  it('does not know in advance whether a claim is true: a lied-about claim is caught, and the bond is slashed', async () => {
    const { node, registry, payments, getLastSlash, job } = await buildServedNode('lying');
    const lines: string[] = [];

    // The lying provider (createLyingRugScoreProvider) tampers "liquidityUsd"
    // by default (see cap-rugscore/src/test-support/lying-provider.ts). This
    // test never asserts that in advance by reading the job's claims and
    // deciding the outcome itself: it challenges the same claim key an honest
    // caller would, and only inspects what the verdict reports afterward.
    const result = await challengeAndSettle(job.jobId, 'liquidityUsd', {
      node,
      print: (line) => lines.push(line),
      getLastSlash,
      hashscanBaseUrl: 'https://hashscan.io/testnet',
    });

    expect(result.verdict.valid).toBe(false);
    expect(result.verdict.badClaim).toBe('liquidityUsd');
    expect(result.verdict.reason).toMatch(/The Graph reports/);
    expect(result.job.status).toBe('slashed');

    // Real money moved (against the fake payments port): exactly one slash,
    // to the configured challenger account, using the bondRef this job's
    // provider actually published.
    expect(payments.slashCalls).toHaveLength(1);
    expect(payments.slashCalls[0]).toMatchObject({ bondRef: manifest.bondRef, toChallenger: CHALLENGER_ACCOUNT_ID });
    expect(getLastSlash()).toMatchObject({ bondRef: manifest.bondRef, toChallenger: CHALLENGER_ACCOUNT_ID });
    expect(getLastSlash()?.txId).toBe(payments.slashCalls[0].txId);

    // Reputation dropped (slashScorePenalty), one more slash on record.
    expect(registry.updateReputationCalls).toHaveLength(1);
    expect(result.reputationAfter.score).toBeLessThan(result.reputationBefore.score);
    expect(result.reputationAfter.slashes).toBe(result.reputationBefore.slashes + 1);

    const output = lines.join('\n');
    expect(output).toContain('FALSE');
    expect(output).toContain('The Graph reports');
    expect(output).toContain('Slash      bond');
    expect(output).toContain('hashscan: https://hashscan.io/testnet/transaction/');
    expect(output).toContain('Reputation');
  });

  it('propagates UnknownClaimError untouched when asked to challenge a claim the job never made', async () => {
    const { node, job } = await buildServedNode('honest');

    await expect(challengeAndSettle(job.jobId, 'notARealClaim', { node })).rejects.toThrow(
      /carries no claim "notARealClaim"/,
    );
  });
});

describe('observeSlash forwarding', () => {
  it('forwards confirmPayment, so wrapping does not downgrade the payment gate', async () => {
    // serve() falls back to the weaker SUCCESS-only confirm() when the port has
    // no confirmPayment, so a wrapper that drops it turns a real amount/memo
    // check into no check at all, silently.
    const calls: string[] = [];
    const base = {
      pay: async () => ({ txId: 'tx' }),
      confirm: async () => true,
      confirmPayment: async (input: { txId: string }) => {
        calls.push(input.txId);
        return { confirmed: true as const };
      },
      postBond: async () => ({ bondRef: 'b', txId: 'tx' }),
      slash: async () => ({ txId: 'tx' }),
    };
    const { payments } = observeSlash(base as never);
    expect(payments.confirmPayment).toBeDefined();
    await payments.confirmPayment!({ txId: 'tx-1', expectedAmountHbar: 5, expectedMemo: 'memo' });
    expect(calls).toEqual(['tx-1']);
  });

  it('omits confirmPayment when the wrapped port does not have it', () => {
    const base = {
      pay: async () => ({ txId: 'tx' }),
      confirm: async () => true,
      postBond: async () => ({ bondRef: 'b', txId: 'tx' }),
      slash: async () => ({ txId: 'tx' }),
    };
    expect(observeSlash(base as never).payments.confirmPayment).toBeUndefined();
  });
});

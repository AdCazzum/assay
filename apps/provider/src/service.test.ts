import { describe, expect, it } from 'vitest';
import { createAssayNode, createCapabilityRegistry } from '@assay/core';
import type { Capability, Manifest } from '@assay/core';
import { createProviderService } from './service.js';
import { FakeGraphPort, FakePaymentsPort, FakeRegistryPort, HangingPaymentsPort } from './fakes.js';

const PROVIDER_NAME = 'rugscore.assay.eth';

const manifest: Manifest = {
  capabilityId: 'rugscore',
  description: 'rug-score, for provider service tests',
  priceHbar: 5,
  endpoint: 'https://example.invalid/serve',
  bondRef: 'bond-seed',
  verifierHash: '0xseed',
};

/**
 * A spy capability standing in for `@assay/cap-rugscore`'s real one. Its
 * `run` is instrumented so tests can assert it was never called, not merely
 * that the response looked like an error — that distinction is the whole
 * point of the payment gate.
 */
function createSpyCapability() {
  const runCalls: unknown[] = [];
  const capability: Capability<unknown, { score: number }> = {
    id: 'rugscore',
    async run(req) {
      runCalls.push(req);
      return { result: { score: 12 }, claims: [{ k: 'top10Pct', v: 62, atBlock: 100 }] };
    },
    async verify() {
      return { valid: true };
    },
  };
  return { capability, runCalls };
}

function buildHarness(paymentsOpts?: ConstructorParameters<typeof FakePaymentsPort>[0]) {
  const registry = new FakeRegistryPort().seed(PROVIDER_NAME, {
    manifest,
    reputation: { score: 80, jobs: 3, slashes: 0, bondHbar: 50 },
  });
  const payments = new FakePaymentsPort(paymentsOpts);
  const graph = new FakeGraphPort();
  const capabilities = createCapabilityRegistry();
  const spy = createSpyCapability();
  capabilities.register(spy.capability);

  const node = createAssayNode({ registry, payments, graph, capabilities });
  const service = createProviderService({ serve: node.serve });

  return { service, payments, spy };
}

describe('ProviderService', () => {
  it('serves a request whose payment is confirmed, returning block-stamped claims', async () => {
    const { service, payments, spy } = buildHarness();
    const { txId } = await payments.pay(5, 'hash-1');

    const outcome = await service.handle({
      provider: PROVIDER_NAME,
      capabilityId: 'rugscore',
      request: '0xTOKEN',
      txId,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok outcome');
    expect(outcome.job.status).toBe('served');
    expect(outcome.job.claims).toEqual([{ k: 'top10Pct', v: 62, atBlock: 100 }]);
    expect(outcome.job.result).toEqual({ score: 12 });
    expect(spy.runCalls).toEqual(['0xTOKEN']);
  });

  it('refuses a request whose payment is not confirmed, and never invokes the capability', async () => {
    const { service, payments, spy } = buildHarness({ confirmedTxIds: [] });
    const { txId } = await payments.pay(5, 'hash-2');

    const outcome = await service.handle({
      provider: PROVIDER_NAME,
      capabilityId: 'rugscore',
      request: '0xTOKEN',
      txId,
    });

    expect(outcome).toMatchObject({ ok: false, code: 'payment_not_confirmed' });
    // the whole point of the gate: not just an error response, the capability
    // itself must never run.
    expect(spy.runCalls).toEqual([]);
    expect(payments.confirmCalls).toEqual([txId]);
  });

  it('times out instead of hanging when the payment never confirms, and never invokes the capability', async () => {
    const registry = new FakeRegistryPort().seed(PROVIDER_NAME, {
      manifest,
      reputation: { score: 80, jobs: 3, slashes: 0, bondHbar: 50 },
    });
    const payments = new HangingPaymentsPort();
    const graph = new FakeGraphPort();
    const capabilities = createCapabilityRegistry();
    const spy = createSpyCapability();
    capabilities.register(spy.capability);

    const node = createAssayNode({ registry, payments, graph, capabilities });
    const service = createProviderService({ serve: node.serve, serveTimeoutMs: 25 });

    const { txId } = await payments.pay(5, 'hash-3');

    const outcome = await service.handle({
      provider: PROVIDER_NAME,
      capabilityId: 'rugscore',
      request: '0xTOKEN',
      txId,
    });

    expect(outcome).toMatchObject({ ok: false, code: 'timeout' });
    expect(spy.runCalls).toEqual([]);
  });

  it('rejects a malformed request (missing txId) before any payment work happens', async () => {
    const { service, payments, spy } = buildHarness();

    const outcome = await service.handle({
      provider: PROVIDER_NAME,
      capabilityId: 'rugscore',
      request: '0xTOKEN',
      // txId deliberately omitted
    });

    expect(outcome).toMatchObject({ ok: false, code: 'malformed_request' });
    expect(payments.confirmCalls).toEqual([]);
    expect(payments.payCalls).toEqual([]);
    expect(spy.runCalls).toEqual([]);
  });

  it.each([
    { case: 'missing provider', raw: { capabilityId: 'rugscore', request: '0x', txId: 't' } },
    { case: 'empty provider', raw: { provider: '', capabilityId: 'rugscore', request: '0x', txId: 't' } },
    { case: 'missing capabilityId', raw: { provider: PROVIDER_NAME, request: '0x', txId: 't' } },
    { case: 'non-string txId', raw: { provider: PROVIDER_NAME, capabilityId: 'rugscore', request: '0x', txId: 42 } },
    { case: 'missing request', raw: { provider: PROVIDER_NAME, capabilityId: 'rugscore', txId: 't' } },
  ])('rejects a malformed request ($case) before any payment work happens', async ({ raw }) => {
    const { service, payments, spy } = buildHarness();

    const outcome = await service.handle(raw as never);

    expect(outcome).toMatchObject({ ok: false, code: 'malformed_request' });
    expect(payments.confirmCalls).toEqual([]);
    expect(spy.runCalls).toEqual([]);
  });
});

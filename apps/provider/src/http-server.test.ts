import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createAssayNode, createCapabilityRegistry } from '@assay/core';
import type { Capability, Manifest } from '@assay/core';
import { createProviderHttpServer } from './http-server.js';
import { createProviderService } from './service.js';
import { FakeGraphPort, FakePaymentsPort, FakeRegistryPort } from './fakes.js';

const PROVIDER_NAME = 'rugscore.assay.eth';

const manifest: Manifest = {
  capabilityId: 'rugscore',
  description: 'rug-score, for http-server tests',
  priceHbar: 5,
  endpoint: 'http://localhost/serve',
  bondRef: 'bond-seed',
  verifierHash: '0xseed',
};

const echoCapability: Capability<unknown, { score: number }> = {
  id: 'rugscore',
  async run() {
    return { result: { score: 1 }, claims: [{ k: 'top10Pct', v: 10, atBlock: 1 }] };
  },
  async verify() {
    return { valid: true };
  },
};

function buildServer(paymentsOpts?: ConstructorParameters<typeof FakePaymentsPort>[0]) {
  const registry = new FakeRegistryPort().seed(PROVIDER_NAME, {
    manifest,
    reputation: { score: 80, jobs: 0, slashes: 0, bondHbar: 50 },
  });
  const payments = new FakePaymentsPort(paymentsOpts);
  const graph = new FakeGraphPort();
  const capabilities = createCapabilityRegistry();
  capabilities.register(echoCapability);
  const node = createAssayNode({ registry, payments, graph, capabilities });
  const service = createProviderService({ serve: node.serve });
  return { server: createProviderHttpServer(service), payments };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('createProviderHttpServer', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('POST /serve returns 200 with the job for a confirmed payment', async () => {
    const built = buildServer();
    server = built.server;
    const { txId } = await built.payments.pay(5, 'hash');
    const baseUrl = await listen(server);

    const res = await fetch(`${baseUrl}/serve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: PROVIDER_NAME, capabilityId: 'rugscore', request: '0xTOKEN', txId }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; job?: { status: string } };
    expect(body.ok).toBe(true);
    expect(body.job?.status).toBe('served');
  });

  it('POST /serve returns 402 for an unconfirmed payment', async () => {
    const built = buildServer({ confirmedTxIds: [] });
    server = built.server;
    const { txId } = await built.payments.pay(5, 'hash');
    const baseUrl = await listen(server);

    const res = await fetch(`${baseUrl}/serve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: PROVIDER_NAME, capabilityId: 'rugscore', request: '0xTOKEN', txId }),
    });

    expect(res.status).toBe(402);
    const body = (await res.json()) as { ok: boolean; code?: string };
    expect(body).toMatchObject({ ok: false, code: 'payment_not_confirmed' });
  });

  it('POST /serve returns 400 for a malformed body', async () => {
    const built = buildServer();
    server = built.server;
    const baseUrl = await listen(server);

    const res = await fetch(`${baseUrl}/serve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: PROVIDER_NAME }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; code?: string };
    expect(body).toMatchObject({ ok: false, code: 'malformed_request' });
  });

  it('returns 404 for any other route', async () => {
    const built = buildServer();
    server = built.server;
    const baseUrl = await listen(server);

    const res = await fetch(`${baseUrl}/nope`, { method: 'GET' });
    expect(res.status).toBe(404);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createHederaPaymentsPort } from './payments.js';
import type { HederaTransferClient, TransferHbarParams } from './hedera-client.js';
import type { FetchLike } from './mirror-node.js';

/**
 * An obviously-named test double for `HederaTransferClient`: records every
 * call and hands back a deterministic, incrementing fake txId. Never talks to
 * a real Hedera network.
 */
class FakeHederaTransferClient implements HederaTransferClient {
  readonly calls: TransferHbarParams[] = [];
  private seq = 0;

  async transferHbar(params: TransferHbarParams): Promise<{ txId: string }> {
    this.calls.push(params);
    this.seq += 1;
    return { txId: `0.0.999@1690000000.${String(this.seq).padStart(9, '0')}` };
  }

  close(): void {
    // no-op: nothing to release on a fake
  }
}

/** A fetch double that always answers "final, SUCCESS" on the first poll. */
const alwaysSuccessFetch: FetchLike = async () => ({
  status: 200,
  json: async () => ({ transactions: [{ result: 'SUCCESS' }] }),
});

function buildPort(client: FakeHederaTransferClient, fetchImpl: FetchLike = alwaysSuccessFetch, confirmTimeoutMs = 1000) {
  return createHederaPaymentsPort({
    client,
    payToAccountId: '0.0.5001',
    bondAccountId: '0.0.5002',
    mirrorNodeBaseUrl: 'https://testnet.mirrornode.hedera.com',
    fetchImpl,
    confirmIntervalMs: 1,
    confirmTimeoutMs,
  });
}

describe('createHederaPaymentsPort: pay', () => {
  it('pays the configured provider account and binds requestHash into the memo', async () => {
    const client = new FakeHederaTransferClient();
    const port = buildPort(client);

    const { txId } = await port.pay(5, 'req-hash-abc123');

    expect(client.calls).toEqual([{ toAccountId: '0.0.5001', amountHbar: 5, memo: 'req-hash-abc123' }]);
    expect(txId).toMatch(/^0\.0\.999@/);
  });
});

describe('createHederaPaymentsPort: confirm', () => {
  it('delegates to the mirror node poller and surfaces its result', async () => {
    const client = new FakeHederaTransferClient();
    const port = buildPort(client);

    const { txId } = await port.pay(5, 'req-hash');
    await expect(port.confirm(txId)).resolves.toBe(true);
  });

  it('propagates a timeout when the mirror node never finalizes the tx', async () => {
    const pendingFetch: FetchLike = async () => ({ status: 404, json: async () => ({}) });
    const client = new FakeHederaTransferClient();
    const port = buildPort(client, pendingFetch, 5);

    const { txId } = await port.pay(5, 'req-hash');
    await expect(port.confirm(txId)).rejects.toThrow(/did not finalize/);
  });
});

describe('createHederaPaymentsPort: postBond / slash', () => {
  it('postBond deposits to the bond account and returns a bondRef', async () => {
    const client = new FakeHederaTransferClient();
    const port = buildPort(client);

    const { bondRef, txId } = await port.postBond(20);

    expect(client.calls).toEqual([{ toAccountId: '0.0.5002', amountHbar: 20, memo: undefined }]);
    expect(bondRef).toContain(txId);
  });

  it('slash pays the bonded amount to the challenger', async () => {
    const client = new FakeHederaTransferClient();
    const port = buildPort(client);

    const { bondRef } = await port.postBond(20);
    const { txId } = await port.slash(bondRef, '0.0.7001');

    expect(client.calls[1]).toEqual({ toAccountId: '0.0.7001', amountHbar: 20 });
    expect(txId).toMatch(/^0\.0\.999@/);
  });

  it('rejects slashing an unknown bondRef', async () => {
    const client = new FakeHederaTransferClient();
    const port = buildPort(client);

    await expect(port.slash('bond-does-not-exist', '0.0.7001')).rejects.toThrow(/unknown bondRef/);
  });

  it('rejects slashing the same bond twice', async () => {
    const client = new FakeHederaTransferClient();
    const port = buildPort(client);

    const { bondRef } = await port.postBond(20);
    await port.slash(bondRef, '0.0.7001');

    await expect(port.slash(bondRef, '0.0.7002')).rejects.toThrow(/already slashed/);
  });
});

describe('createHederaPaymentsPort: onConfirmAttempt observability', () => {
  it('reports each poll attempt so callers can observe settle timing', async () => {
    const client = new FakeHederaTransferClient();
    const onConfirmAttempt = vi.fn();
    const port = createHederaPaymentsPort({
      client,
      payToAccountId: '0.0.5001',
      bondAccountId: '0.0.5002',
      mirrorNodeBaseUrl: 'https://testnet.mirrornode.hedera.com',
      fetchImpl: alwaysSuccessFetch,
      confirmIntervalMs: 1,
      confirmTimeoutMs: 1000,
      onConfirmAttempt,
    });

    const { txId } = await port.pay(1, 'req');
    await port.confirm(txId);

    expect(onConfirmAttempt).toHaveBeenCalledWith(expect.objectContaining({ state: 'success' }));
  });
});

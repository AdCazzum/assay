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

/** A fetch double that always answers "final, SUCCESS" on the first poll, with no transfers/memo. */
const alwaysSuccessFetch: FetchLike = async () => ({
  status: 200,
  json: async () => ({ transactions: [{ result: 'SUCCESS' }] }),
});

/**
 * A fetch double that answers "final, SUCCESS" with the given transfers and
 * memo, as `pollMirrorNodeTransaction` (and therefore `confirmPayment`) would
 * see them for a real payment.
 */
function successFetchWith(opts: { toAccountId: string; amountHbar: number; memo: string }): FetchLike {
  const memoBase64 = Buffer.from(opts.memo, 'utf8').toString('base64');
  return async () => ({
    status: 200,
    json: async () => ({
      transactions: [
        {
          result: 'SUCCESS',
          transfers: [{ account: opts.toAccountId, amount: Math.round(opts.amountHbar * 100_000_000) }],
          memo_base64: memoBase64,
        },
      ],
    }),
  });
}

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

describe('createHederaPaymentsPort: confirmPayment (hedera-F1)', () => {
  it('confirms when the recipient was actually paid at least the expected amount with the expected memo', async () => {
    const client = new FakeHederaTransferClient();
    const fetchImpl = successFetchWith({ toAccountId: '0.0.5001', amountHbar: 5, memo: 'req-hash-abc123' });
    const port = buildPort(client, fetchImpl);

    const { txId } = await port.pay(5, 'req-hash-abc123');
    const confirmation = await port.confirmPayment!({ txId, expectedAmountHbar: 5, expectedMemo: 'req-hash-abc123' });

    expect(confirmation).toEqual({ confirmed: true });
  });

  it('confirms when the recipient was paid more than the expected amount (a stricter minimum than plain equality)', async () => {
    const client = new FakeHederaTransferClient();
    const fetchImpl = successFetchWith({ toAccountId: '0.0.5001', amountHbar: 10, memo: 'req-hash' });
    const port = buildPort(client, fetchImpl);

    const { txId } = await port.pay(10, 'req-hash');
    const confirmation = await port.confirmPayment!({ txId, expectedAmountHbar: 5, expectedMemo: 'req-hash' });

    expect(confirmation).toEqual({ confirmed: true });
  });

  it('refuses when the mirror node reports a final, non-SUCCESS result', async () => {
    const client = new FakeHederaTransferClient();
    const failedFetch: FetchLike = async () => ({
      status: 200,
      json: async () => ({ transactions: [{ result: 'INVALID_SIGNATURE' }] }),
    });
    const port = buildPort(client, failedFetch);

    const { txId } = await port.pay(5, 'req-hash');
    const confirmation = await port.confirmPayment!({ txId, expectedAmountHbar: 5, expectedMemo: 'req-hash' });

    expect(confirmation).toEqual({ confirmed: false, reason: 'unsuccessful' });
  });

  it('propagates a timeout (same as confirm()) when the mirror node never finalizes the tx at all', async () => {
    const client = new FakeHederaTransferClient();
    const pendingFetch: FetchLike = async () => ({ status: 404, json: async () => ({}) });
    const port = buildPort(client, pendingFetch, 5);

    const { txId } = await port.pay(5, 'req-hash');
    await expect(
      port.confirmPayment!({ txId, expectedAmountHbar: 5, expectedMemo: 'req-hash' }),
    ).rejects.toThrow(/did not finalize/);
  });

  it('refuses when the confirmed transaction paid less than the expected amount (hedera-F1: a trivial fee-only transfer no longer unlocks the capability)', async () => {
    const client = new FakeHederaTransferClient();
    const fetchImpl = successFetchWith({ toAccountId: '0.0.5001', amountHbar: 0.0001, memo: 'req-hash' });
    const port = buildPort(client, fetchImpl);

    const { txId } = await port.pay(0.0001, 'req-hash');
    const confirmation = await port.confirmPayment!({ txId, expectedAmountHbar: 5, expectedMemo: 'req-hash' });

    expect(confirmation).toEqual({ confirmed: false, reason: 'amount-too-low' });
  });

  it('refuses when the confirmed transaction paid the right amount to a *different* account than this port\'s configured recipient', async () => {
    const client = new FakeHederaTransferClient();
    // Paid in full, but to some other account -- not this port's payToAccountId ("0.0.5001").
    const fetchImpl = successFetchWith({ toAccountId: '0.0.9999', amountHbar: 5, memo: 'req-hash' });
    const port = buildPort(client, fetchImpl);

    const { txId } = await port.pay(5, 'req-hash');
    const confirmation = await port.confirmPayment!({ txId, expectedAmountHbar: 5, expectedMemo: 'req-hash' });

    expect(confirmation).toEqual({ confirmed: false, reason: 'amount-too-low' });
  });

  it('refuses when the memo does not match the expected requestHash, even though the amount and recipient are right (the binding the docs claim actually enforced)', async () => {
    const client = new FakeHederaTransferClient();
    const fetchImpl = successFetchWith({ toAccountId: '0.0.5001', amountHbar: 5, memo: 'memo-for-a-different-request' });
    const port = buildPort(client, fetchImpl);

    const { txId } = await port.pay(5, 'memo-for-a-different-request');
    const confirmation = await port.confirmPayment!({ txId, expectedAmountHbar: 5, expectedMemo: 'req-hash' });

    expect(confirmation).toEqual({ confirmed: false, reason: 'memo-mismatch' });
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

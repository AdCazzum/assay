import { describe, expect, it, vi } from 'vitest';
import { MirrorNodeTimeoutError, pollMirrorNode, toMirrorNodeTransactionId } from './mirror-node.js';
import type { FetchLike } from './mirror-node.js';

const TX_ID = '0.0.1234@1690000000.123456789';
const BASE_URL = 'https://testnet.mirrornode.hedera.com';

/** A fetch double that answers the mirror node's "not yet ingested" 404. */
function pendingResponse() {
  return { status: 404, json: async () => ({ _status: { messages: [{ message: 'Not found' }] } }) };
}

function transactionResponse(result: string) {
  return { status: 200, json: async () => ({ transactions: [{ result }] }) };
}

describe('toMirrorNodeTransactionId', () => {
  it('replaces the "@" and the seconds/nanos "." with "-", leaving the account id dots alone', () => {
    expect(toMirrorNodeTransactionId('0.0.1234@1690000000.123456789')).toBe('0.0.1234-1690000000-123456789');
  });

  it('throws on a string that is not an SDK-format transaction id', () => {
    expect(() => toMirrorNodeTransactionId('not-a-tx-id')).toThrow(/missing '@'/);
  });
});

describe('pollMirrorNode', () => {
  it('resolves true once the mirror node reports SUCCESS, after some pending polls', async () => {
    const fetchImpl: FetchLike = vi
      .fn()
      .mockResolvedValueOnce(pendingResponse())
      .mockResolvedValueOnce(pendingResponse())
      .mockResolvedValueOnce(transactionResponse('SUCCESS'));

    const attempts: string[] = [];
    const result = await pollMirrorNode(TX_ID, {
      baseUrl: BASE_URL,
      fetchImpl,
      intervalMs: 1,
      timeoutMs: 1000,
      onAttempt: (info) => attempts.push(info.state),
    });

    expect(result).toBe(true);
    expect(attempts).toEqual(['pending', 'pending', 'success']);
    expect(fetchImpl).toHaveBeenCalledWith(`${BASE_URL}/api/v1/transactions/0.0.1234-1690000000-123456789`);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('resolves false when the mirror node reports a final non-SUCCESS result', async () => {
    const fetchImpl: FetchLike = vi.fn().mockResolvedValue(transactionResponse('INVALID_SIGNATURE'));

    const result = await pollMirrorNode(TX_ID, { baseUrl: BASE_URL, fetchImpl, intervalMs: 1, timeoutMs: 1000 });

    expect(result).toBe(false);
  });

  it('rejects with MirrorNodeTimeoutError when the transaction never appears within timeoutMs', async () => {
    const fetchImpl: FetchLike = vi.fn().mockResolvedValue(pendingResponse());

    await expect(
      pollMirrorNode(TX_ID, { baseUrl: BASE_URL, fetchImpl, intervalMs: 1, timeoutMs: 5 }),
    ).rejects.toThrow(MirrorNodeTimeoutError);
  });

  it('strips a trailing slash from baseUrl', async () => {
    const fetchImpl: FetchLike = vi.fn().mockResolvedValue(transactionResponse('SUCCESS'));

    await pollMirrorNode(TX_ID, { baseUrl: `${BASE_URL}/`, fetchImpl, intervalMs: 1, timeoutMs: 1000 });

    expect(fetchImpl).toHaveBeenCalledWith(`${BASE_URL}/api/v1/transactions/0.0.1234-1690000000-123456789`);
  });
});

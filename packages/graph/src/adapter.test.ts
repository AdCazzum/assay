import { describe, expect, it, vi } from 'vitest';
import { createGraphAdapter } from './adapter.js';
import { GraphRateLimitError, GraphTokenNotFoundError } from './errors.js';
import { HEAD_PROXY_TOKEN, STABLECOINS, ZERO_ADDRESS } from './constants.js';

const TOKEN = '0x00000000000000000000000000000000000dead';
const POOL = '0x00000000000000000000000000000000000ee11';
const USDC = STABLECOINS.USDC;

/**
 * FakeTokenApiFetch — an obviously-named test double for the Token API's
 * HTTP surface. Routes requests by pathname (+ a couple of query params it
 * cares about) to canned fixture responses, and records every call so tests
 * can assert exactly which query the adapter issued (e.g. which `end_block`
 * it used for the block-stamping guarantee). This is NOT a mock of live
 * Token API data being passed off as real — it stands in for the transport
 * only, in unit tests, and is never used by the live smoke script.
 */
function createFakeTokenApiFetch(overrides: {
  tokensRow?: Record<string, unknown>;
  holderRows?: Record<string, unknown>[];
  transferRows?: Record<string, unknown>[];
  poolRows?: Record<string, unknown>[];
  balanceRows?: Record<string, unknown>[];
  status?: number;
  retryAfterSeconds?: number;
} = {}) {
  const calls: { path: string; params: URLSearchParams }[] = [];

  const respond = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers }));

  const fetchFn = vi.fn((input: Parameters<typeof fetch>[0]) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    calls.push({ path: url.pathname, params: url.searchParams });

    if (overrides.status && overrides.status !== 200) {
      const headers: Record<string, string> = {};
      if (overrides.retryAfterSeconds !== undefined) {
        headers['Retry-After'] = String(overrides.retryAfterSeconds);
      }
      return respond({ error: 'rate limited' }, overrides.status, headers);
    }

    if (url.pathname === '/v1/evm/tokens') {
      const contract = url.searchParams.get('contract');
      if (contract === HEAD_PROXY_TOKEN) {
        return respond({
          data: [
            {
              contract: HEAD_PROXY_TOKEN,
              circulating_supply: '1000000',
              holders: 900000,
              total_transfers: 5000000,
              last_update_block_num: 20500000,
            },
          ],
        });
      }
      if (contract === TOKEN) {
        return respond({ data: overrides.tokensRow ? [overrides.tokensRow] : [] });
      }
      return respond({ data: [] });
    }

    if (url.pathname === '/v1/evm/holders') {
      return respond({ data: overrides.holderRows ?? [] });
    }

    if (url.pathname === '/v1/evm/transfers') {
      return respond({ data: overrides.transferRows ?? [] });
    }

    if (url.pathname === '/v1/evm/pools') {
      const isInput = url.searchParams.has('input_token');
      return respond({ data: isInput ? (overrides.poolRows ?? []) : [] });
    }

    if (url.pathname === '/v1/evm/balances') {
      return respond({ data: overrides.balanceRows ?? [] });
    }

    return respond({ error: 'unhandled route in FakeTokenApiFetch' }, 404);
  });

  return { fetchFn, calls };
}

function defaultTokensRow(lastUpdateBlockNum: number) {
  return {
    contract: TOKEN,
    circulating_supply: '1000000',
    holders: 500,
    total_transfers: 10000,
    last_update_block_num: lastUpdateBlockNum,
  };
}

function holderRow(value: number) {
  return { address: `0x${value.toString(16).padStart(40, '0')}`, value };
}

function transferRow(blockNum: number, from = '0xabc', to = '0xdef') {
  return { block_num: blockNum, from, to };
}

describe('createGraphAdapter', () => {
  it('maps a happy-path token to the full TokenSignals shape', async () => {
    const { fetchFn } = createFakeTokenApiFetch({
      tokensRow: defaultTokensRow(20000000),
      holderRows: [holderRow(60000), holderRow(20000), holderRow(20000)], // sums to 100000 -> 10% of 1_000_000
      poolRows: [
        {
          pool: POOL,
          factory: '0xfactory',
          protocol: 'uniswap_v2',
          input_token: { address: TOKEN, symbol: 'TOK', decimals: 18 },
          output_token: { address: USDC, symbol: 'USDC', decimals: 6 },
        },
      ],
      balanceRows: [{ address: POOL, contract: USDC, value: 50000 }],
      transferRows: [
        transferRow(19999000),
        transferRow(19999999, ZERO_ADDRESS, '0x111'), // recent mint
        transferRow(19999500),
      ],
    });

    const adapter = createGraphAdapter({ apiKey: 'test-key', fetch: fetchFn as unknown as typeof fetch });
    const signals = await adapter.getTokenSignals(TOKEN);

    expect(signals).toEqual({
      atBlock: 20000000,
      holders: 500,
      top10Pct: 10,
      liquidityUsd: 100000, // 2x the 50_000 USDC reserve
      ageBlocks: 1000, // 20_000_000 - 19_999_000
      transfers: 10000,
      hasActiveMintRole: true,
    });
  });

  it('reports no recent mint and a smaller age when transfers show none', async () => {
    const { fetchFn } = createFakeTokenApiFetch({
      tokensRow: defaultTokensRow(20000000),
      holderRows: [],
      poolRows: [],
      balanceRows: [],
      transferRows: [transferRow(19998000)],
    });

    const adapter = createGraphAdapter({ apiKey: 'test-key', fetch: fetchFn as unknown as typeof fetch });
    const signals = await adapter.getTokenSignals(TOKEN);

    expect(signals.hasActiveMintRole).toBe(false);
    expect(signals.ageBlocks).toBe(2000);
    expect(signals.liquidityUsd).toBe(0);
    expect(signals.top10Pct).toBe(0);
  });

  it('throws GraphTokenNotFoundError when the Token API has no row for the contract', async () => {
    const { fetchFn } = createFakeTokenApiFetch({ tokensRow: undefined });
    const adapter = createGraphAdapter({ apiKey: 'test-key', fetch: fetchFn as unknown as typeof fetch });

    await expect(adapter.getTokenSignals(TOKEN)).rejects.toBeInstanceOf(GraphTokenNotFoundError);
  });

  it('surfaces a 429 as a typed GraphRateLimitError, not a bare throw', async () => {
    const { fetchFn } = createFakeTokenApiFetch({ status: 429, retryAfterSeconds: 30 });
    const adapter = createGraphAdapter({ apiKey: 'test-key', fetch: fetchFn as unknown as typeof fetch });

    const error = await adapter.getTokenSignals(TOKEN).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphRateLimitError);
    expect((error as GraphRateLimitError).retryAfterSeconds).toBe(30);
  });

  describe('block-stamping', () => {
    it('stamps the result with the block actually queried when it matches the request', async () => {
      const { fetchFn, calls } = createFakeTokenApiFetch({
        tokensRow: defaultTokensRow(19500000),
        holderRows: [],
        poolRows: [],
        balanceRows: [],
        transferRows: [transferRow(19499000)],
      });

      const adapter = createGraphAdapter({ apiKey: 'test-key', fetch: fetchFn as unknown as typeof fetch });
      const signals = await adapter.getTokenSignals(TOKEN, 19500000);

      expect(signals.atBlock).toBe(19500000);
      const transfersCall = calls.find((c) => c.path === '/v1/evm/transfers');
      expect(transfersCall?.params.get('end_block')).toBe('19500000');
    });

    it('never echoes back a stale requested block it did not actually query', async () => {
      // The token's live indexed block (20000000) has moved past whatever the
      // caller asked for (19000000) — the Token API's holders/tokens
      // endpoints have no historical filter, so we cannot honestly serve
      // block 19000000 for them. The envelope must reflect the block we
      // actually used, not silently echo the stale request.
      const { fetchFn, calls } = createFakeTokenApiFetch({
        tokensRow: defaultTokensRow(20000000),
        holderRows: [],
        poolRows: [],
        balanceRows: [],
        transferRows: [transferRow(18999000)],
      });

      const adapter = createGraphAdapter({ apiKey: 'test-key', fetch: fetchFn as unknown as typeof fetch });
      const signals = await adapter.getTokenSignals(TOKEN, 19000000);

      expect(signals.atBlock).toBe(20000000);
      expect(signals.atBlock).not.toBe(19000000);
      // but ageBlocks/hasActiveMintRole *do* honour the requested block for
      // their own /v1/evm/transfers query:
      const transfersCall = calls.find((c) => c.path === '/v1/evm/transfers');
      expect(transfersCall?.params.get('end_block')).toBe('19000000');
      expect(signals.ageBlocks).toBe(1000); // 19_000_000 - 18_999_000
    });
  });

  describe('getLatestBlock', () => {
    it('reads the reference token last_update_block_num as a live head proxy', async () => {
      const { fetchFn } = createFakeTokenApiFetch({});
      const adapter = createGraphAdapter({ apiKey: 'test-key', fetch: fetchFn as unknown as typeof fetch });

      await expect(adapter.getLatestBlock()).resolves.toBe(20500000);
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createGraphAdapter } from './adapter.js';
import {
  GraphBlockOutOfRangeError,
  GraphMalformedResponseError,
  GraphRateLimitError,
  GraphTokenNotFoundError,
} from './errors.js';

const TOKEN = '0x00000000000000000000000000000000000dEaD';
const TOKEN_LOWER = TOKEN.toLowerCase();
const SUBGRAPH_ID = 'test-subgraph-id';

type TokenScenario = {
  txCount: string;
  volumeUsd: string;
  /** Pool TVLs, in the order the fake returns them for the TVL-desc query (largest first). */
  poolTvlsDesc?: string[];
  oldestPoolCreatedAtBlock?: number;
} | 'not-found';
type BlockRangeReason = 'before-start' | 'not-yet-indexed';

/**
 * FakeGatewayFetch — an obviously-named test double for the gateway's HTTP
 * surface. Routes each POST body by its GraphQL operation (`_meta` vs the
 * token-signals query) and by the `$block` variable, to canned responses.
 * Records every call so tests can assert exactly which block/id/sample-size
 * the adapter pinned. This stands in for the transport only, in unit tests;
 * it never pretends to be real subgraph data and is never used by the live
 * smoke script.
 */
function createFakeGatewayFetch(config: {
  metaBlock?: number;
  tokensByBlock?: Record<number, TokenScenario>;
  status?: number;
  retryAfterSeconds?: number;
  blockRangeErrorFor?: (block: number) => BlockRangeReason | undefined;
}) {
  const calls: { query: string; variables?: Record<string, unknown> }[] = [];

  const respond = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

  const fetchFn = vi.fn((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { query: string; variables?: Record<string, unknown> };
    calls.push({ query: body.query, variables: body.variables });

    if (config.status && config.status !== 200) {
      const headers: Record<string, string> =
        config.retryAfterSeconds !== undefined ? { 'Retry-After': String(config.retryAfterSeconds) } : {};
      return Promise.resolve(
        new Response(JSON.stringify({ errors: [{ message: 'rate limited' }] }), { status: config.status, headers }),
      );
    }

    if (body.query.includes('_meta')) {
      return respond({ data: { _meta: { block: { number: config.metaBlock ?? 0 } } } });
    }

    const block = body.variables?.block as number;
    if (config.blockRangeErrorFor) {
      const reason = config.blockRangeErrorFor(block);
      if (reason === 'before-start') {
        return respond({
          errors: [
            { message: `bad query: bad query: requested block ${block}, before minimum \`startBlock\` of manifest 12369621` },
          ],
        });
      }
      if (reason === 'not-yet-indexed') {
        return respond({
          errors: [{ message: `bad indexers: {0xabc: Unavailable(missing block: ${block}, latest: 999)}` }],
        });
      }
    }

    const scenario = config.tokensByBlock?.[block];
    if (scenario === undefined || scenario === 'not-found') {
      return respond({ data: { token: null, oldestPool: [], topPools: [] } });
    }
    return respond({
      data: {
        token: { txCount: scenario.txCount, volumeUSD: scenario.volumeUsd },
        oldestPool:
          scenario.oldestPoolCreatedAtBlock !== undefined
            ? [{ createdAtBlockNumber: String(scenario.oldestPoolCreatedAtBlock) }]
            : [],
        topPools: (scenario.poolTvlsDesc ?? []).map((tvl) => ({ totalValueLockedUSD: tvl })),
      },
    });
  });

  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

describe('createGraphAdapter', () => {
  it('maps a happy-path token to TokenSignals: every field real, none a sentinel', async () => {
    const { fetchFn } = createFakeGatewayFetch({
      tokensByBlock: {
        20000000: {
          txCount: '13682874',
          volumeUsd: '749453784937.16',
          oldestPoolCreatedAtBlock: 12369760,
          poolTvlsDesc: ['472941909.09', '396697962.81', '88573949.61'],
        },
      },
    });
    const adapter = createGraphAdapter({ apiKey: 'test-key', fetch: fetchFn, subgraphId: SUBGRAPH_ID });

    const signals = await adapter.getTokenSignals(TOKEN, 20000000);

    expect(signals.atBlock).toBe(20000000);
    expect(signals.txCount).toBe(13682874);
    expect(signals.volumeUsd).toBeCloseTo(749453784937.16);
    expect(signals.ageBlocks).toBe(20000000 - 12369760);
    expect(signals.liquidityUsd).toBeCloseTo(472941909.09);
    const expectedPct = (472941909.09 / (472941909.09 + 396697962.81 + 88573949.61)) * 100;
    expect(signals.topPoolConcentrationPct).toBeCloseTo(expectedPct);
  });

  describe('block-pinning', () => {
    it('sends the exact requested block and the top-pools sample size in the query variables', async () => {
      const { fetchFn, calls } = createFakeGatewayFetch({
        tokensByBlock: {
          20000000: { txCount: '1', volumeUsd: '1', oldestPoolCreatedAtBlock: 19000000, poolTvlsDesc: ['1'] },
        },
      });
      const adapter = createGraphAdapter({ apiKey: 'test-key', fetch: fetchFn, subgraphId: SUBGRAPH_ID });

      await adapter.getTokenSignals(TOKEN, 20000000);

      const signalsCall = calls.find((c) => !c.query.includes('_meta'));
      expect(signalsCall?.variables?.block).toBe(20000000);
      expect(signalsCall?.variables?.id).toBe(TOKEN_LOWER);
      expect(signalsCall?.variables?.topPoolsFirst).toBe(5);
    });

    it('proves two different blocks yield genuinely different values for the same token', async () => {
      const { fetchFn } = createFakeGatewayFetch({
        tokensByBlock: {
          20000000: {
            txCount: '13682874',
            volumeUsd: '749453784937',
            oldestPoolCreatedAtBlock: 12369760,
            poolTvlsDesc: ['472941909', '396697962'],
          },
          22000000: {
            txCount: '18679418',
            volumeUsd: '881318888823',
            oldestPoolCreatedAtBlock: 12369760,
            poolTvlsDesc: ['414385665', '310305299'],
          },
        },
      });
      const adapter = createGraphAdapter({ apiKey: 'test-key', fetch: fetchFn, subgraphId: SUBGRAPH_ID });

      const early = await adapter.getTokenSignals(TOKEN, 20000000);
      const later = await adapter.getTokenSignals(TOKEN, 22000000);

      expect(early.liquidityUsd).not.toBe(later.liquidityUsd);
      expect(early.txCount).not.toBe(later.txCount);
      expect(early.volumeUsd).not.toBe(later.volumeUsd);
      expect(early.atBlock).toBe(20000000);
      expect(later.atBlock).toBe(22000000);
    });

    it('lower-cases a checksummed token address before querying, since the subgraph keys ids by lower-case address', async () => {
      const { fetchFn, calls } = createFakeGatewayFetch({
        tokensByBlock: { 20000000: { txCount: '1', volumeUsd: '0' } },
      });
      const adapter = createGraphAdapter({ apiKey: 'test-key', fetch: fetchFn, subgraphId: SUBGRAPH_ID });

      await adapter.getTokenSignals(TOKEN, 20000000);

      const signalsCall = calls.find((c) => !c.query.includes('_meta'));
      expect(signalsCall?.variables?.id).toBe(TOKEN_LOWER);
      expect(signalsCall?.variables?.id).not.toBe(TOKEN);
    });

    it('reports ageBlocks, liquidityUsd and topPoolConcentrationPct as NaN, not zero, when no Uniswap v3 pool exists yet for the token', async () => {
      const { fetchFn } = createFakeGatewayFetch({
        tokensByBlock: { 20000000: { txCount: '0', volumeUsd: '0' } },
      });
      const adapter = createGraphAdapter({ apiKey: 'test-key', fetch: fetchFn, subgraphId: SUBGRAPH_ID });

      const signals = await adapter.getTokenSignals(TOKEN, 20000000);

      expect(Number.isNaN(signals.ageBlocks)).toBe(true);
      expect(Number.isNaN(signals.liquidityUsd)).toBe(true);
      expect(Number.isNaN(signals.topPoolConcentrationPct)).toBe(true);
      expect(signals.txCount).toBe(0); // a real, honest zero — distinct from the NaN "no pool yet" sentinel
    });

    it('reports topPoolConcentrationPct as 100 when only one pool has ever traded the token', async () => {
      const { fetchFn } = createFakeGatewayFetch({
        tokensByBlock: {
          20000000: {
            txCount: '2',
            volumeUsd: '0',
            oldestPoolCreatedAtBlock: 19999900,
            poolTvlsDesc: ['56.51'],
          },
        },
      });
      const adapter = createGraphAdapter({ apiKey: 'test-key', fetch: fetchFn, subgraphId: SUBGRAPH_ID });

      const signals = await adapter.getTokenSignals(TOKEN, 20000000);

      expect(signals.liquidityUsd).toBeCloseTo(56.51);
      expect(signals.topPoolConcentrationPct).toBe(100);
    });

    it('resolves atBlock via getLatestBlock when the caller omits it, and pins the signals query to that same block', async () => {
      const { fetchFn, calls } = createFakeGatewayFetch({
        metaBlock: 21000000,
        tokensByBlock: {
          21000000: { txCount: '1', volumeUsd: '1', oldestPoolCreatedAtBlock: 20000000, poolTvlsDesc: ['1'] },
        },
      });
      const adapter = createGraphAdapter({ apiKey: 'test-key', fetch: fetchFn, subgraphId: SUBGRAPH_ID });

      const signals = await adapter.getTokenSignals(TOKEN);

      expect(signals.atBlock).toBe(21000000);
      const signalsCall = calls.find((c) => !c.query.includes('_meta'));
      expect(signalsCall?.variables?.block).toBe(21000000);
    });

    it('throws GraphBlockOutOfRangeError("before-start") when the block predates the subgraph manifest', async () => {
      const { fetchFn } = createFakeGatewayFetch({
        blockRangeErrorFor: () => 'before-start',
      });
      const adapter = createGraphAdapter({ apiKey: 'test-key', fetch: fetchFn, subgraphId: SUBGRAPH_ID });

      const error = await adapter.getTokenSignals(TOKEN, 1000).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GraphBlockOutOfRangeError);
      expect((error as GraphBlockOutOfRangeError).reason).toBe('before-start');
      expect((error as GraphBlockOutOfRangeError).atBlock).toBe(1000);
    });

    it('throws GraphBlockOutOfRangeError("not-yet-indexed") when indexers have not reached the block yet', async () => {
      const { fetchFn } = createFakeGatewayFetch({
        blockRangeErrorFor: () => 'not-yet-indexed',
      });
      const adapter = createGraphAdapter({ apiKey: 'test-key', fetch: fetchFn, subgraphId: SUBGRAPH_ID });

      const error = await adapter.getTokenSignals(TOKEN, 99999999).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GraphBlockOutOfRangeError);
      expect((error as GraphBlockOutOfRangeError).reason).toBe('not-yet-indexed');
    });
  });

  it('throws GraphTokenNotFoundError when the subgraph has no token entity for the contract', async () => {
    const { fetchFn } = createFakeGatewayFetch({ tokensByBlock: { 20000000: 'not-found' } });
    const adapter = createGraphAdapter({ apiKey: 'test-key', fetch: fetchFn, subgraphId: SUBGRAPH_ID });

    await expect(adapter.getTokenSignals(TOKEN, 20000000)).rejects.toBeInstanceOf(GraphTokenNotFoundError);
  });

  it('surfaces a 429 as a typed GraphRateLimitError, not a bare throw', async () => {
    const { fetchFn } = createFakeGatewayFetch({ status: 429, retryAfterSeconds: 30 });
    const adapter = createGraphAdapter({ apiKey: 'test-key', fetch: fetchFn, subgraphId: SUBGRAPH_ID });

    const error = await adapter.getTokenSignals(TOKEN, 20000000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphRateLimitError);
    expect((error as GraphRateLimitError).retryAfterSeconds).toBe(30);
  });

  it('throws GraphMalformedResponseError when txCount is missing from a 2xx response', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ data: { token: { notWhatWeExpect: true }, oldestPool: [], topPools: [] } }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;
    const adapter = createGraphAdapter({ apiKey: 'test-key', fetch: fetchFn, subgraphId: SUBGRAPH_ID });

    await expect(adapter.getTokenSignals(TOKEN, 20000000)).rejects.toBeInstanceOf(GraphMalformedResponseError);
  });

  describe('getLatestBlock', () => {
    it('reads _meta.block.number as the subgraph-own indexed head', async () => {
      const { fetchFn, calls } = createFakeGatewayFetch({ metaBlock: 20500000 });
      const adapter = createGraphAdapter({ apiKey: 'test-key', fetch: fetchFn, subgraphId: SUBGRAPH_ID });

      await expect(adapter.getLatestBlock()).resolves.toBe(20500000);
      expect(calls[0]?.query).toContain('_meta');
    });
  });
});

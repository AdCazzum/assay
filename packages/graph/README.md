# @assay/graph

`GraphPort` (see `packages/core/src/ports.ts`) implemented over **The Graph's
decentralized gateway**, querying the **Uniswap v3 mainnet subgraph**
directly with GraphQL. This is the source of truth both the provider and the
verifier read through, so its correctness decides whether honest providers
get slashed (SPEC §12).

No client SDK or schema library is added: `fetch` is injected
(`createGraphAdapter({ apiKey, fetch })`) so unit tests drive a fake
(`FakeGatewayFetch` in `adapter.test.ts`), and response fields are validated
by hand in `src/gatewayClient.ts`.

## Why this exists / what changed (#49, follow-up to #42)

#42 moved this package onto block-pinned subgraph queries, which was the
right call, but only two of six `TokenSignals` fields survived as real reads
(`liquidityUsd`, `ageBlocks`); the other four (`holders`, `top10Pct`,
`transfers`, `hasActiveMintRole`) had no subgraph reachable through the
gateway that could honestly source them, so the adapter filled them with
sentinels (`NaN`, or `false` for the boolean). `hasActiveMintRole` was the
dangerous one: a boolean has no `NaN`, so "unimplemented" was indistinguishable
from "false", and a verifier trusting that field would compare a real
provider claim against a constant. #49 removes the sentinels rather than
growing the list: `TokenSignals` now carries exactly the fields this
subgraph genuinely exposes at a pinned block, verified live (see below), and
nothing else.

Two more things changed along the way, both caught by re-verifying live
rather than trusting #42's own writeup or memory of the schema (per the
issue's own instruction):

- **`poolCount`** exists on the `Token` entity and looked like a natural fit
  for the issue's "pool count" candidate, but querying it live for USDC
  returns `"0"` at every block, including the current head — this field is
  not populated by this subgraph deployment's mappings. Counting pools by
  hand (`pools(first: 1000, where: ...)`) hits the gateway's per-query
  row cap for a token with USDC's pool count, so an exact count would need
  paginating past 1000 rows — one query per 1000 pools, which breaks the
  cost asymmetry SPEC §3 requires (verifying one claim must stay a single
  cheap query). Dropped rather than shipped as an approximation.
- **`liquidityUsd` moved from `token.totalValueLockedUSD` to the deepest
  pool's own `totalValueLockedUSD`.** Live testing against a real, very
  young/thin token (see below) turned up a genuine landmine in the field #42
  shipped: `token.totalValueLockedUSD` reads exactly `0` for a token whose
  own price (`derivedETH`) this subgraph has not established yet (typically
  because every pool trading it is below the subgraph's own pricing-confidence
  threshold) — **even though a real, non-empty pool for that token exists,
  with a real, nonzero pool-level TVL.** That is indistinguishable from
  "genuinely no liquidity" and is exactly the kind of silent-wrong-reading
  this issue exists to catch: it would make an honest provider's true (small
  but real) liquidity claim look like a lie, or worse, make `0` look like the
  honest baseline a rug-score provider is expected to report even when real,
  spendable liquidity exists. The deepest single pool's own TVL is computed
  independently of the token's own price feed (it only needs the *paired*
  token, usually WETH, to be priced) and was confirmed live to report a real
  nonzero figure in exactly the case the token-level field zeroed out.

## Which subgraph, and how each field was verified

**Uniswap v3, Ethereum mainnet**, subgraph id
`5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV`
(`UNISWAP_V3_MAINNET_SUBGRAPH_ID` in `constants.ts`), queried at
`https://gateway.thegraph.com/api/<GRAPH_API_KEY>/subgraphs/id/<id>`.

Schema introspected live on 2026-07-25 (`__type(name: "Token")` /
`__type(name: "Pool")`) rather than assumed from #42's writeup or memory,
per this issue's own instruction to verify every candidate live. `Token`
exposes `txCount`, `volumeUSD`, `poolCount`, `totalValueLockedUSD`,
`derivedETH` directly; `Pool` exposes `totalValueLockedUSD`,
`createdAtBlockNumber`, `liquidity`, `token0Price`/`token1Price`, and more.

Live-queried, real, block-pinned, reproducing #42's own block-20000000 USDC
row and extending it:

| block | txCount | volumeUSD | top pool TVL (USD) | top-pool concentration |
|---|---|---|---|---|
| 20000000 | 13682874 | 749453784937.16 | 472941909.10 | 42.5% |
| 22000000 | 18679419 | 881318888823.06 | 414385665.83 | 37.3% |

independently queried from this box on 2026-07-25 — the exact numbers keep
moving as the chain advances (USDC trades every block), which is itself the
point: *the same query at two different pinned blocks returns two different
numbers*, which `adapter.test.ts` and `scripts/smoke.ts` both prove fresh.

Also verified live, both load-bearing for this adapter's design (carried over
from #42, unchanged by #49):

- `_meta { block { number } }` answers with no `block` argument (the
  subgraph's own indexed head) — this is what `getLatestBlock()` uses.
- A block before the manifest's start returns a **loud GraphQL error**:
  `bad query: bad query: requested block 1000, before minimum
  \`startBlock\` of manifest 12369621` — this is `startBlock`
  (`UNISWAP_V3_MAINNET_START_BLOCK`).
- A block past what the gateway's indexers have processed also errors, with
  a *different* message shape: `bad indexers: {0x...:
  Unavailable(missing block: 99999999, latest: ...)}`. Both are wrapped as
  `GraphBlockOutOfRangeError` (`reason: 'before-start' | 'not-yet-indexed'`).
- Querying `token(id: "0xA0b8...")` with a **checksummed** address returns
  `token: null` — this subgraph keys `Token.id` by the **lower-cased**
  address. See "Address casing" below.

**The thin/sketchy contrast, live and real.** To stress-test every field
against a token that is the opposite of USDC, not a fixture, this issue
queried the 20 most-recently-created pools live and picked two genuinely thin
tokens still on mainnet as of 2026-07-25:

- `GOODCAT` (`0xd6c68bc8c862722e140e7b339ddf8a144a7d3530`): one pool, created
  a few thousand blocks before the query, `txCount = 2`, `volumeUSD = 0`,
  top-pool TVL **$56.51**, concentration **100%** (only one pool exists).
- `yRise` (`0x6051c1354ccc51b4d561e43b02735deae64768b8`): `txCount = 122`,
  `volumeUSD ≈ $148`, top-pool TVL **$0.16**, concentration **73.4%** across
  a small handful of pools — real trading activity around essentially no
  remaining locked value, which is exactly the shape a drained/rugged pool
  leaves behind.

Both are real mainnet contracts, verified live, not test doubles — see
"Real vs mocked" in `SPEC.md` §11: the tokens are real, only the "lying
provider" harness in `cap-rugscore`'s tests is a declared double.

## `TokenSignals` field mapping

| Field | Source | Notes |
|---|---|---|
| `atBlock` | the `$block` actually queried (the caller's `atBlock`, or `getLatestBlock()`'s result when omitted) | real |
| `liquidityUsd` | the deepest Uniswap v3 pool trading this token, `totalValueLockedUSD`, from `topPools` (see below) | **real, block-pinned**; a single-venue figure, not a token-wide aggregate — see "why this exists" above |
| `ageBlocks` | `$block` minus the earliest-created pool's `createdAtBlockNumber`, from `oldestPool` | **real, block-pinned**, a disclosed lower bound (see below) |
| `txCount` | `token.txCount` | **real, block-pinned**; Uniswap v3 swap/mint/burn count, *not* raw ERC-20 `Transfer` events (the subgraph does not track those — named `txCount`, never `transfers`, so it can't be mistaken for one) |
| `volumeUsd` | `token.volumeUSD` | **real, block-pinned**; cumulative tracked trading volume in USD |
| `topPoolConcentrationPct` | the deepest pool's TVL as a % of the combined TVL of the top `TOP_POOLS_SAMPLE_SIZE` (5) pools, from `topPools` | **real, block-pinned**, bounded to a 5-pool sample (see below) |

One GraphQL request per `getTokenSignals` call carries three aliased root
selections (`token`, `oldestPool`, `topPools`), so every field above is one
round trip — the same "verifying a claim costs one targeted query" property
#42 established, preserved through this change.

### `ageBlocks`: a real, block-pinned, but lower-bound signal

`oldestPool` only returns pools that existed *as of* `$block` — if the token
has no Uniswap v3 pool yet at that block, the list is empty, and `ageBlocks`
is reported as `NaN` ("not observed on this venue as of this block"), not
`0` ("brand new"): those are different claims, and conflating them would be
exactly the kind of invented precision this issue exists to remove.

When a pool *is* found, `ageBlocks = $block - createdAtBlockNumber` of the
earliest one. This is a genuine, block-pinned read, but still a **lower
bound**, not true contract-deployment age, for any token older than its
first Uniswap v3 listing — USDC included, which predates Uniswap v3 itself.
"At least this old, on this venue" is what the number means.

### `topPoolConcentrationPct`: bounded to a 5-pool sample, and why

A token's true liquidity concentration would need summing `totalValueLockedUSD`
across *every* pool trading it. For USDC that is well over 1000 pools (a live
`pools(first: 1000)` query for USDC hit the gateway's row cap and returned
exactly 1000 results, confirming pagination would be required); paginating a
1000-row cap per claim, per verify, is not "a single pinned query" anymore.
`TOP_POOLS_SAMPLE_SIZE` (5, `constants.ts`) samples only the deepest 5 pools
by TVL — enough to show whether a token's liquidity sits in one venue (rug
shape: 100%, one pool) or is spread across several (blue-chip shape: USDC
measured at 37-43% in its single deepest pool across the two blocks above),
while keeping the query cheap. Disclosed as a bound, the same trade-off
`ageBlocks` already makes.

### What was investigated and rejected

- **`poolCount`** — see "why this exists" above: the schema field itself is
  unpopulated (`"0"` always), and an honest hand-counted alternative doesn't
  fit the cost asymmetry this project depends on.
- **`derivedETH`** — real and block-pinned (a token's price in ETH), but it
  is an FX rate, not a risk signal on its own; nothing in `scoreRugPullRisk`
  needs a bare price without a reference to compare it against, so it is
  left out of `TokenSignals` rather than included unused.
- **`holders` / `top10Pct` (ERC-20 holder concentration)** — still
  unreachable: no subgraph indexing balance-ranked ERC-20 holders was found
  serving through the gateway (two community subgraph ids tried live during
  #42 both returned `subgraph not found: no allocations`). `topPoolConcentrationPct`
  covers the "concentration" angle #49's issue asks for, but over liquidity
  venues, not holder balances — a different, real signal, not a substitute
  dressed up as the original.
- **`hasActiveMintRole`** — still unreachable: needs contract-level
  introspection (bytecode or a role-check `eth_call`), which no subgraph
  exposes. This was the field that made #42's sentinel design actively
  dangerous (a boolean can't carry "missing"); #49 removes it rather than
  inventing a weaker proxy.

## `getLatestBlock()`: report a head you can actually query

`_meta { block { number } }`, queried with no `block` argument, reports the
block **this subgraph's own indexers** have reached. This is deliberately
not "the true chain head from an RPC provider": that number can be ahead of
what this subgraph has indexed to, and pinning a subsequent query to it would
then fail with the same `not-yet-indexed` error documented below (confirmed
live: querying a block far past `_meta`'s reported head returns `bad
indexers: {...: Unavailable(missing block: ..., latest: ...)}`).
`getLatestBlock()` uses `_meta` from the *same* subgraph every other query in
this package hits, so a `getTokenSignals(token, await getLatestBlock())`
round trip is always pinnable.

## Block-out-of-range: two real error shapes, one typed error

`GraphBlockOutOfRangeError` (`errors.ts`) wraps both real failure modes
observed live against this subgraph:

- `reason: 'before-start'` — the block predates the subgraph manifest's
  indexed history (`before minimum \`startBlock\``). Nothing before block
  `UNISWAP_V3_MAINNET_START_BLOCK` (12369621, Uniswap v3's own mainnet
  deployment) can ever be answered by this subgraph.
- `reason: 'not-yet-indexed'` — the block is more recent than what the
  gateway's indexers have processed so far (`Unavailable(missing block: ...,
  latest: ...)`). This is the "subtler trap" #42's issue called out: naively
  asking an RPC provider for the chain head and pinning to it can race ahead
  of subgraph indexing and fail this way — which is exactly why
  `getLatestBlock()` above deliberately reports the subgraph's own head
  instead.

Either way, the caller gets a typed exception with `.atBlock` and `.reason`,
never a silent fallback to unpinned/live data.

## Address casing

This subgraph's `Token.id` (and pool `token0`/`token1` filters) are keyed by
the **lower-cased** contract address. A checksummed address (mixed case, EIP-55)
silently matches nothing — `token: null` — rather than erroring, which would
be indistinguishable from "this token genuinely has no Uniswap v3 presence."
`normalizeTokenAddress()` (`constants.ts`) lower-cases every address this
adapter sends before it is used, and a test in `adapter.test.ts` asserts this.

## Design notes

- **Why no zod / GraphQL client library.** No package in this workspace
  declares one, and adding one would touch `pnpm-lock.yaml`, which every
  parallel agent building a sibling package would collide on (see
  `AGENTS.md`). Response fields are validated by hand in `gatewayClient.ts`
  (`asRow`/`asNumericString`/`asIntNumber`): a missing or mistyped field
  throws `GraphMalformedResponseError` rather than silently becoming
  `undefined`/`NaN` and corrupting a signal downstream. Note the subgraph
  serialises `BigInt`/`BigDecimal` scalars (block numbers, TVL, tx counts,
  volume) as JSON *strings*, while plain `Int` scalars (`_meta.block.number`)
  are JSON *numbers* — both parsing paths are handled and tested separately.
- **Errors:** `GraphApiError` (HTTP/GraphQL-level failure not about block
  range), `GraphRateLimitError` (429, with `retryAfterSeconds` when the
  gateway sends `Retry-After`), `GraphBlockOutOfRangeError` (see above),
  `GraphTokenNotFoundError` (`token` resolved to `null` — never traded on
  this venue, or not an ERC-20 on this network), and
  `GraphMalformedResponseError` (2xx with no GraphQL errors, but a field
  failed validation).
- **Test doubles:** `adapter.test.ts`'s `createFakeGatewayFetch` builds a
  `FakeGatewayFetch` — an obviously-named fake that stands in for the HTTP
  transport only, in unit tests, and is never used by `scripts/smoke.ts`.

## Live smoke test

```sh
pnpm --filter @assay/graph exec tsx scripts/smoke.ts
```

Reads `GRAPH_API_KEY` from the repo root `.env` (see `.env.example`), then:
queries this subgraph's own indexed head; queries USDC signals pinned to two
different historical blocks and prints both, plus an explicit PASS/FAIL on
whether `liquidityUsd`, `txCount` and `volumeUsd` actually differed between
them (the block-pinning proof this issue asks for); queries the current head
with `atBlock` omitted; queries the two real thin/sketchy tokens above
(`GOODCAT`, `yRise`) at the current head for contrast; and confirms a block
before the manifest start fails with `GraphBlockOutOfRangeError` rather than
succeeding. Exits with a clear message, no stack trace, if the key is
missing.

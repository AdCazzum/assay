# @assay/graph

`GraphPort` (see `packages/core/src/ports.ts`) implemented over **The Graph's
decentralized gateway**, querying the **Uniswap v3 mainnet subgraph**
directly with GraphQL. This is the source of truth both the provider and the
verifier read through, so its correctness decides whether honest providers
get slashed (SPEC §12).

This replaces the previous implementation over The Graph's Token API (see
"Why this exists / what changed" below). No client SDK or schema library is
added: `fetch` is injected (`createGraphAdapter({ apiKey, fetch })`) so unit
tests drive a fake (`FakeGatewayFetch` in `adapter.test.ts`), and response
fields are validated by hand in `src/gatewayClient.ts`, same approach as
before.

## Why this exists / what changed (#42, follow-up to #10)

The Token API adapter #10 shipped could not honour `atBlock` for four of six
`TokenSignals` fields (`holders`, `top10Pct`, `liquidityUsd`, `transfers`):
those endpoints have no historical-block parameter at all and only ever
reflect the indexer's live state. That is fatal for a verifier that must
re-derive a claim **at the same block** it was made at (SPEC §12) — comparing
against live state instead means the verifier is really comparing against
"whatever changed since serve time," which slashes honest providers on data
drift, not on lies. Separately, the Token API's docs moved behind a
different product (Pinax) requiring a different kind of credential than the
`GRAPH_API_KEY` this project actually has.

Subgraph queries through `gateway.thegraph.com`, by contrast, accept a
`block: { number: N }` argument per field and genuinely honour it — a query
pinned to a historical block returns the state **as of that block**, and a
block the subgraph cannot honestly answer for is a loud GraphQL error, never
a silent live-data fallback. That is the property this package is built
around now.

## Which subgraph, and how it was verified

**Uniswap v3, Ethereum mainnet**, subgraph id
`5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV`
(`UNISWAP_V3_MAINNET_SUBGRAPH_ID` in `constants.ts`), queried at
`https://gateway.thegraph.com/api/<GRAPH_API_KEY>/subgraphs/id/<id>`.

Verified live against a real Studio key on 2026-07-25, reproducing the exact
block-20000000 row from the issue for USDC (`0xa0b8...eb48`):

| block | txCount | totalValueLockedUSD |
|---|---|---|
| 20000000 | 13682874 | 640775689.2757809999999999999999998 |

independently queried from this box, byte-for-byte matching the issue's own
prior measurement. The issue's 22000000/24000000 rows are not re-quoted here
since USDC's TVL keeps moving and the exact figures are not the point — the
point is that *the same query at two different pinned blocks returns two
different numbers*, which `scripts/smoke.ts` (below) proves fresh on every
run, and which `live_evidence` for this PR shows for a real run.

Also verified live, both load-bearing for this adapter's design:

- `_meta { block { number } }` answers with no `block` argument (the
  subgraph's own indexed head) — this is what `getLatestBlock()` uses.
- A block before the manifest's start returns a **loud GraphQL error**:
  `bad query: bad query: requested block 1000, before minimum
  \`startBlock\` of manifest 12369621` — this is `startBlock`
  (`UNISWAP_V3_MAINNET_START_BLOCK`).
- A block past what the gateway's indexers have processed also errors, with
  a *different* message shape: `bad indexers: {0x...:
  Unavailable(missing block: 99999999, latest: 25605448), ...}`. Both are
  wrapped as `GraphBlockOutOfRangeError` (`reason: 'before-start' |
  'not-yet-indexed'`) — see "Block-out-of-range" below.
- Querying `token(id: "0xA0b8...")` with a **checksummed** address returns
  `token: null` — this subgraph keys `Token.id` by the **lower-cased**
  address. See "Address casing" below.

Two candidate community subgraphs that might have covered `holders`
(`ERC20 Balances Mainnet`, id `35AYsvtJ7SjD93JZcjHK7KTSFyC8h74YHkg2hTxRsRer`,
and `erc20-holder-ethereum-mainnet`, id
`7jFFJAp92CCHDAxxY5znN9BnRjefgdmH4BPyqDfwbCSU`) were tried live against the
gateway and both returned `subgraph not found: no allocations` — nobody is
currently indexing them on the decentralized network, so the gateway cannot
serve them at all, pinned or not. Per the issue's own instruction ("verify
every subgraph id with a real query before building on it"), that
disqualifies them; see "What is left unimplemented, and why" below.

## `TokenSignals` field mapping

| Field | Source | Real or unimplemented |
|---|---|---|
| `atBlock` | the `$block` actually queried (the caller's `atBlock`, or `getLatestBlock()`'s result when omitted) | real |
| `liquidityUsd` | `token(id, block).totalValueLockedUSD` | **real, block-pinned** |
| `ageBlocks` | `$block` minus the earliest-created Uniswap v3 `pool` trading this token (`pools(where: token0/token1, orderBy: createdAtBlockNumber asc, first: 1, block)`) | **real, block-pinned**, a disclosed lower bound (see below) |
| `holders` | — | **unimplemented** (`NaN`) |
| `top10Pct` | — | **unimplemented** (`NaN`) |
| `transfers` | — | **unimplemented** (`NaN`) |
| `hasActiveMintRole` | — | **unimplemented** (`false`) |

`UNIMPLEMENTED_SIGNAL_KEYS` in `constants.ts` lists the four unimplemented
fields programmatically, so a consumer does not have to guess from the
sentinel value which fields are real; `adapter.test.ts` asserts the returned
object actually matches that list.

### `ageBlocks`: a real, block-pinned, but lower-bound signal

`pools(..., block: { number: $block })` only returns pools that existed *as
of* `$block` — if the token has no Uniswap v3 pool yet at that block, the
list is empty, and `ageBlocks` is reported as `NaN` ("not observed on this
venue as of this block"), not `0` ("brand new"): those are different claims
and conflating them would be exactly the kind of invented precision this
issue exists to remove.

When a pool *is* found, `ageBlocks = $block - createdAtBlockNumber` of the
earliest one. This is a genuine, block-pinned read (unlike the old Token-API
adapter's `ageBlocks`, which was never block-pinned at all), but it is
still a **lower bound**, not true contract-deployment age, for any token
older than its first Uniswap v3 listing — USDC included, which predates
Uniswap v3 itself. "At least this old, on this venue" is what the number
means.

### `holders`, `top10Pct`, `transfers`, `hasActiveMintRole`: what is left unimplemented, and why

None of these can be honestly answered by a block-pinned subgraph query
within this package's scope right now:

- **`holders`** and **`top10Pct`** need a balance-ranked view of every
  holder of the token, which the Uniswap v3 subgraph does not track (it
  indexes pools/swaps, not ERC-20 balances generally). The two community
  subgraphs that claim to cover this were unreachable through the gateway
  (see above) — not "we didn't look," but "we looked, tried live queries,
  and they don't answer."
- **`transfers`** — Uniswap v3's `Token.txCount` is a real, block-pinned
  number, but it counts Uniswap v3 swaps/mints/burns involving the token,
  not raw ERC-20 `Transfer` events. Relabelling that as `transfers` would be
  exactly the "derivation dressed as a read" #10 was flagged for, so it is
  left unimplemented instead of quietly repurposed.
- **`hasActiveMintRole`** needs contract-level introspection (bytecode or a
  role-check `eth_call`), which no subgraph exposes; the old Token-API
  adapter's version of this field was already disclosed as "a behavioral
  proxy, not a role check" — this package does not attempt a weaker proxy
  either, since a proxy over the wrong kind of transfer event (Uniswap v3
  Mint/Burn are LP-share events, not the token's own ERC-20 `Transfer`) would
  be actively misleading, not just approximate.

If SPEC's rug-score capability needs any of these four, it needs a second,
purpose-built adapter (a dedicated ERC-20 balances subgraph once one is
verifiably indexed, or a direct RPC read for mint-role introspection) —
that is out of scope for a Uniswap-v3-subgraph-only package.

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
  latest: ...)`). This is the "subtler trap" the issue calls out: naively
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
  serialises `BigInt`/`BigDecimal` scalars (block numbers, TVL) as JSON
  *strings*, while plain `Int` scalars (`_meta.block.number`) are JSON
  *numbers* — both parsing paths are handled and tested separately.
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
whether `liquidityUsd` actually differed between them (the block-pinning
proof this issue asks for); queries the current head with `atBlock` omitted;
and confirms a block before the manifest start fails with
`GraphBlockOutOfRangeError` rather than succeeding. Exits with a clear
message, no stack trace, if the key is missing.

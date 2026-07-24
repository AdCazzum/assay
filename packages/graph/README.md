# @assay/graph

`GraphPort` (see `packages/core/src/ports.ts`) implemented over **The Graph's
Token API** (mainnet, read-only), served by Pinax at
`https://api.pinax.network`. This is the source of truth both the provider and
the verifier read through, so its correctness decides whether honest providers
get slashed (SPEC §12).

No client SDK or schema library is used: `fetch` is injected
(`createGraphAdapter({ apiKey, fetch })`) so unit tests drive a fake, and
response rows are validated by hand in `src/tokenApi.ts` (see "Why no zod"
below).

## Which endpoints, and how they were found

The Token API's docs at `thegraph.com/docs/en/token-api/...` 301-redirect to
`app.pinax.network/docs/api/...` (checked 2026-07-24, via WebSearch +
context7's `graphprotocol/docs` and live fetches of the redirected pages).
There is no hosted OpenAPI JSON at a stable URL, so endpoint paths, params and
response fields below are transcribed from those rendered docs pages, plus one
live unauthenticated request (`curl .../v1/evm/pools` → `401
{"error":{"status":401,"code":"unauthorized"}}`) that confirmed the host is
live and the error shape.

Auth: `Authorization: Bearer <GRAPH_API_KEY>` (same convention as the rest of
The Graph's API key auth). Rate limiting: undocumented limits, `429` on
overage (confirmed in prose docs, not tested against a real key here since
none exists yet — see `blocked_on_credentials`).

## TokenSignals field mapping

| Field | Endpoint(s) | Real-time or historical? |
|---|---|---|
| `holders` | `GET /v1/evm/tokens?contract=` → `holders` | **Real-time only** |
| `transfers` | `GET /v1/evm/tokens?contract=` → `total_transfers` | **Real-time only** |
| `top10Pct` | `GET /v1/evm/holders?contract=&limit=10` (top holder `value`s, summed) ÷ `GET /v1/evm/tokens` → `circulating_supply` | **Real-time only** |
| `liquidityUsd` | `GET /v1/evm/pools?input_token=` / `output_token=` to find pools, then `GET /v1/evm/balances?address=<pool>&contract=<stablecoin>` for the stablecoin side | **Real-time only**, approximated (see below) |
| `ageBlocks` | `GET /v1/evm/transfers?contract=&end_block=&age=180` — `endBlock` minus the oldest `block_num` seen | **Historically pinnable**, bounded (see below) |
| `hasActiveMintRole` | same `/v1/evm/transfers` window — any transfer `from` the zero address within `MINT_RECENCY_BLOCKS` of `endBlock` | **Historically pinnable**, and a behavioral proxy, not a role check (see below) |
| `atBlock` | `GET /v1/evm/tokens` → `last_update_block_num` for the queried token | the block the real-time fields above actually reflect |

## The block-stamping finding (SPEC §12)

**Four of the six `TokenSignals` fields (`holders`, `top10Pct`,
`liquidityUsd`, `transfers`) come from Token API endpoints
(`/v1/evm/tokens`, `/v1/evm/holders`, `/v1/evm/pools`, `/v1/evm/balances`)
that have no historical-block parameter at all.** They only ever reflect the
indexer's current state; there is no way to ask any of them "what was this
value at block N" for a past N. Only `/v1/evm/transfers` accepts
`start_block`/`end_block`, which is why `ageBlocks` and `hasActiveMintRole`
are the only two signals this adapter can actually pin to a caller-supplied
`atBlock`.

This adapter never pretends otherwise: `getTokenSignals(token, atBlock)`
always stamps its result with the block it could actually stand behind
(`last_update_block_num` for the token, from `/v1/evm/tokens`) — **not** the
caller's requested `atBlock` when the two differ. See
`adapter.test.ts`'s "block-stamping" tests for both cases (request matches
live state; request is stale and gets honestly overridden).

**What this means for SPEC §12 / the verifier design:** a verifier that calls
`getTokenSignals(token, claim.atBlock)` some time after serve, expecting to
reproduce a bond-relevant claim about `holders`/`top10Pct`/`liquidityUsd`
*at the exact serve-time block*, cannot get that from the Token API through
this adapter — it will get *current* data instead, honestly labeled with the
current block. In the demo, the challenge happens seconds to minutes after
serve, so drift in these real-time-only fields is expected to be negligible
in practice; treat that as a "the timescale is short" argument, not a
data-integrity guarantee. SPEC §12's own proposed mitigation — cache a
snapshot at serve time, and have the verifier compare against that cached
snapshot rather than re-querying live — is the actual fix, and it has to live
above this adapter (in `cap-rugscore` or `core`), because the Token API gives
this package nothing to build a true historical query on for those four
fields.

## `getLatestBlock()`: there is no chain-head endpoint

The Token API has no `/blocks` or `/network` endpoint that returns "the
current head". `getLatestBlock()` uses `last_update_block_num` from
`/v1/evm/tokens` for a fixed, highly-liquid reference contract (WETH,
`HEAD_PROXY_TOKEN` in `constants.ts`), which trades on effectively every
mainnet block, as a live proxy for the chain head. This is real, live data —
not a fabricated block number — but it is an approximation: it can lag the
true head by the indexer's own processing latency (typically framed as
sub-block in Pinax's docs, unverified against a real key here).

## `liquidityUsd`: an approximation, not a TVL feed

Neither `/v1/evm/pools` nor `/v1/evm/pools/ohlc` returns a USD-denominated
reserve or TVL figure — `pools` returns pool/token metadata and a
transaction count, `pools/ohlc` returns price candles (open/high/low/close)
and volume, not reserves. There is no separate "prices" endpoint documented
either.

So `liquidityUsd` is derived, not read: for every pool where `token` trades
directly against a recognised stablecoin (`STABLECOINS` in `constants.ts`:
USDC, USDT, DAI), we read the stablecoin's balance held by the pool contract
via `/v1/evm/balances?address=<pool>&contract=<stablecoin>` (the balances
endpoint works on any address, pool contracts included) and double it,
assuming a roughly symmetric-value two-sided pool. Known biases, disclosed
rather than hidden:

- **Undercounts** liquidity that only exists in pools *not* paired against a
  recognised stablecoin (e.g. TOKEN/WETH with no direct stablecoin pool). A
  token with real liquidity only against WETH reports `liquidityUsd: 0`
  here, which means "not detected by this method", not "confirmed zero".
- **Mis-weights** non-50/50 AMMs (Curve, Balancer, concentrated-liquidity
  Uniswap v3/v4 ranges) where "double one side" isn't the right multiplier.
- Real-time only, like `holders`/`top10Pct`/`transfers` above.

A more complete version would need a genuine price oracle to value non-
stablecoin pairs, which is out of scope for this package (Token-API-only,
per `AGENTS.md`).

## `ageBlocks`: a documented lower bound, capped by API retention

`/v1/evm/transfers` defaults to 30 days of history and maxes out at 180 days
via its `age` parameter (per Pinax's docs) — we always pass `age: 180` to get
the largest window available. Within one page (`TRANSFER_SCAN_LIMIT` rows,
`constants.ts`), we take the oldest `block_num` seen and report
`endBlock - oldestBlockSeen`.

Two honest caveats:

1. If the token has more transfers in-window than fit in one page, the
   oldest transfer *in the page* isn't necessarily the oldest *in the
   window* — `ageBlocks` underestimates for very active tokens.
2. If the token is older than the API's ~180-day retention (true for almost
   any established token — USDC included), `ageBlocks` reports "at least
   this old", not the true age since deployment; the Token API has no
   deployment-block field anywhere.

This floor is arguably fine for what `ageBlocks` is *for* in `cap-rugscore`
(SPEC §6): a rug-score heuristic mainly needs to distinguish freshly
deployed tokens from established ones, and it does that correctly within the
window; it just can't tell you *how* established an old token is beyond "at
least ~180 days".

## `hasActiveMintRole`: a behavioral proxy, not a role check

No Token API endpoint exposes contract bytecode, `owner()`, or role data —
checked `tokens`, `holders`, `transfers`, `balances`, `pools`, `pools/ohlc`,
`balances/historical` (the full EVM-tokens/EVM-DEX surface documented); none
of it is contract introspection. A true "does this contract currently have a
privileged, callable mint function" check needs an RPC read (bytecode scan
or a known-selector `eth_call`), which is out of scope for a Token-API-only,
read-only adapter (see `AGENTS.md`'s package boundary for `packages/graph`).

Instead, `hasActiveMintRole` answers a related, honestly-different question
from the same transfer window used for `ageBlocks`: **has this contract
minted (a transfer *from* the zero address) within `MINT_RECENCY_BLOCKS`
(~7200 blocks, ~1 day) of the evaluated block?** This is a real, disclosed
proxy with a known error direction:

- **False negative:** a contract can hold an active, callable mint role and
  simply not have used it recently.
- **False positive (rare):** a burn-then-remint accounting pattern could
  look like a fresh mint without a genuinely privileged, ongoing mint
  capability.

If SPEC's rug-score claim for `hasActiveMintRole` needs the stronger,
bytecode-level guarantee, that has to come from a second adapter (a direct
mainnet RPC read) composed alongside this one — not from the Token API.

## Design notes

- **Why no zod.** No package in this workspace declares `zod` as a
  dependency yet (checked every `packages/*/package.json`), and adding one
  here would touch `pnpm-lock.yaml`, which every parallel agent building a
  sibling package would collide on (see `AGENTS.md`). Response rows are
  validated by hand in `tokenApi.ts` (`asString`/`asFiniteNumber`/`asRow`):
  a missing or mistyped field throws a `GraphMalformedResponseError` rather
  than silently becoming `undefined`/`NaN` and corrupting a signal downstream.
- **Errors:** `GraphApiError` (HTTP non-2xx), `GraphRateLimitError` (429,
  with `retryAfterSeconds` when the API sends `Retry-After`),
  `GraphTokenNotFoundError` (`/v1/evm/tokens` had no row for the contract —
  never indexed, or not an ERC-20 on this network), and
  `GraphMalformedResponseError` (2xx but a row failed validation).
- **Test doubles:** `adapter.test.ts`'s `createFakeTokenApiFetch` is an
  obviously-named fake — it stands in for the HTTP transport only, in unit
  tests, and is never used by `scripts/smoke.ts`.

## Live smoke test

```sh
pnpm --filter @assay/graph exec tsx scripts/smoke.ts
```

Reads `GRAPH_API_KEY` from the repo root `.env` (see `.env.example`), queries
USDC (a clean, well-known control token) for `getLatestBlock()` and
`getTokenSignals()` (both live and pinned to that latest block), and prints
the results. Exits with a clear message, no stack trace, if the key is
missing. **Not run yet against a real key** — `.env` isn't provisioned in
this environment (see the PR / `blocked_on_credentials`).

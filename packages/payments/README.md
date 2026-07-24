# @assay/payments

Hedera testnet adapter for `PaymentsPort` (issue #4: prove the rail, pick it).

## Rail decision: raw HBAR transfer, not a sponsor rail

I spent the first ~15 minutes checking what actually exists today for agent
payments on Hedera, before writing any adapter code.

- **x402 on Hedera.** Hedera has a real, accepted x402 "exact" payment scheme
  with a TypeScript reference facilitator implementation on the Hiero SDK
  ([Hedera blog](https://hedera.com/blog/hedera-and-the-x402-payment-standard/)).
  It's genuine, but the scheme is facilitator-mediated: the client signs a
  partially-complete transaction, and a third party (the facilitator) fills in
  the fee payer and broadcasts it. That means either standing up my own
  facilitator or trusting someone else's during the hackathon, and it pulls in
  x402-specific packages that are not in this workspace's dependency set.
- **Hedera Agent Kit v4.** Real and actively developed
  ([Hedera blog](https://hedera.com/blog/hedera-agent-kit-v4-policies-modular-packages-and-plugin-updates/)),
  but it's an LLM tool-calling wrapper (LangChain/ADK style "give an agent a
  `transfer_hbar` tool") around the same `@hashgraph/sdk` calls this package
  already makes directly. Assay's agent-facing surface is the MCP server in
  `apps/mcp`, not a second LLM tool layer inside the payments adapter, so the
  Agent Kit would add a dependency for a job the SDK already does.
- **OpenClaw ACP.** Not Hedera at all: every agent gets a wallet on Base chain
  ([Virtual Protocol's ACP CLI](https://github.com/Virtual-Protocol/openclaw-acp)).
  Doesn't apply here.

Decisive factor: **AGENTS.md forbids adding npm dependencies** (a new package
rewrites `pnpm-lock.yaml`, the one file every parallel agent would collide on),
and only `@hashgraph/sdk` is installed for this package, not any x402 or Agent
Kit package. Even setting that rule aside, both sponsor routes add real
integration surface (a facilitator to trust or run, an LLM tool-calling layer)
for a 36h build that doesn't need either: the winning claim for the Hedera
bounty is "pay + bond + slash are real testnet transactions", not "we used a
particular SDK wrapper" (SPEC.md §15 says this explicitly: a raw transfer is
the safe floor and still qualifies).

So: **`PaymentsPort` is a raw `TransferTransaction`, with `requestHash` in the
transaction memo, confirmed by polling the mirror node's REST API.** This
matches the fallback SPEC.md and the issue call for, chosen after checking, not
by default.

## Design

- `pay(amountHbar, requestHash)` — a `TransferTransaction` from the operator
  to a `payToAccountId` bound at construction time (see below), with
  `requestHash` written to `setTransactionMemo`. The memo is the only field on
  a plain transfer that carries an application payload, and Hedera memos cap
  at 100 bytes, comfortably enough for a hash. Returns the SDK's transaction
  id immediately; it does not itself wait for consensus.
- `confirm(txId)` — polls `GET /api/v1/transactions/{id}` on the mirror node
  (converting the SDK's `0.0.x@seconds.nanos` id to the mirror node's
  `0.0.x-seconds-nanos` form) until it reports a final result or a bounded
  timeout (default 15s, 1s interval — the mirror node's typical ingestion lag
  is ~1-2s past consensus) elapses. Resolves `true` on `SUCCESS`, `false` on
  any other final result, and rejects with `MirrorNodeTimeoutError` if the
  mirror node never surfaces the transaction in time. Every poll is reported
  through an `onAttempt`/`onConfirmAttempt` callback (attempt number, elapsed
  ms, state), which is how `scripts/spike.ts` prints the settle time the
  demo's "sub-second settlement" claim rests on.
- `postBond(amountHbar)` / `slash(bondRef, toChallenger)` — literally "a
  deposit and a transfer" per the issue and SPEC.md §17 (no staking protocol).
  `postBond` transfers to a configured `bondAccountId` and returns a `bondRef`
  that's just a locally-generated key into an in-memory `Map<bondRef, amount>`
  — `slash` looks the amount back up by that key and transfers it to
  `toChallenger`. This ledger is intentionally not durable: SPEC.md §17 rules
  out real staking, and the rest of the project keeps state in an in-memory
  job store too. A bond can't be slashed twice (a second `slash` on the same
  `bondRef` throws).

### The two parameters `PaymentsPort` doesn't have

`ports.ts` is frozen, and `pay`/`postBond` don't take a recipient, and `slash`
doesn't take an amount. I resolved that by binding the counterparty accounts
(`payToAccountId`, `bondAccountId`) at `createHederaPaymentsPort(...)`
construction time instead — one `PaymentsPort` instance per relationship (a
requester's instance is constructed already knowing which provider it pays) —
and by keeping the bond amount in the in-memory ledger described above so
`slash` can look it up from just the `bondRef`.

### Testability

`createHederaPaymentsPort` takes an injected `HederaTransferClient` (real impl:
`createHederaSdkTransferClient`, wrapping `@hashgraph/sdk`) and an injected
`fetchImpl` for the mirror node poll. Tests drive `FakeHederaTransferClient`
(in `payments.test.ts`, obviously named, never touches a real network) and a
hand-written fake `fetch`. `mirror-node.test.ts` covers the poll state machine
directly: pending → success, pending → a final non-SUCCESS result, and
pending → timeout. The Hedera SDK itself is not unit-tested — `hedera-client.ts`
is exercised for real by `scripts/spike.ts`, once credentials exist.

## Unproven

**The live round trip has not been executed.** There is no `.env` in this
repo (no Hedera testnet operator account yet), so nothing here has touched
testnet or a real mirror node. What's actually verified:

- `pnpm --filter @assay/payments typecheck` and `test` pass (14 tests: the
  mirror-node poll state machine, requestHash binding, bond deposit/slash,
  double-slash rejection).
- `scripts/spike.ts` fails cleanly (one-line message to stderr, exit code 1,
  no stack trace) when `HEDERA_OPERATOR_ID`/`HEDERA_OPERATOR_KEY` are unset —
  this was actually run and observed, not assumed.
- `PrivateKey.fromString(...)` is used for the operator key, which
  auto-detects DER-encoded ED25519 vs ECDSA. That covers what the Hedera
  testnet portal typically hands out, but it's unverified against a real key;
  it's the first thing to check if `scripts/spike.ts` fails once credentials
  land.
- The default poll timeout (15s) and interval (1s) are informed guesses based
  on documented mirror node lag, not measured against a live testnet mirror
  node.

If you see a stray `undefined` line on stdout when running via
`pnpm --filter @assay/payments exec tsx scripts/spike.ts` and it fails, check
stderr: that `undefined` comes from pnpm's own `--filter … exec` failure
reporting (reproduced with an unrelated script), not from this code. Running
`tsx scripts/spike.ts` directly from this package's directory does not show it.

## Running the spike once credentials exist

```
pnpm --filter @assay/payments exec tsx scripts/spike.ts
```

Reads `HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY` / `HEDERA_NETWORK` from a
`.env` at the repo root (see `.env.example`). Pays a small amount of HBAR
(0.01 by default, override with `SPIKE_AMOUNT_HBAR`) to itself (there's no
second testnet account provisioned yet — override with
`SPIKE_PAY_TO_ACCOUNT_ID` once one exists), confirms it via the mirror node,
and prints the settle time in milliseconds plus a HashScan link.

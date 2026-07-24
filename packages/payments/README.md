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

## Proven on live testnet

The round trip ran against Hedera testnet on 2026-07-24, operator `0.0.9695801`:

```
[spike] operator key verified against 0.0.9695801
[spike] paying 0.01 HBAR: 0.0.9695801 -> 0.0.9695801
[spike] requestHash (memo): spike-1784929790998
[spike] submitted, txId=0.0.9695801@1784929785.951608160
  poll #1 at   26ms: pending
  poll #5 at 4116ms: success
[spike] confirmed=true settle_time_ms=4116
```

Verified on the mirror node: `result=SUCCESS`, memo decodes to
`spike-1784929790998` (so the requestHash really is bound to the payment, which
is what payment-gating rests on), fee 0.0014 HBAR.

**Settlement took 4.1s wall clock**, of which consensus is roughly 3s and the
rest is mirror-node ingestion lag. The 15s default poll timeout has ~4x
headroom, which is the right order of magnitude but worth re-measuring on
conference wifi before the demo. Do not claim "sub-second settlement" on stage:
consensus is fast, but the number a viewer sees is the confirm loop, and that is
about four seconds.

### postBond / slash, proven on live testnet

`scripts/bond-slash.ts` runs the same round trip for `postBond` and `slash`
(issue #7), against Hedera testnet on 2026-07-24, operator `0.0.9695801`:

```
[bond-slash] operator key verified against 0.0.9695801
[bond-slash] NOTE: only one funded testnet account exists, so both postBond and
slash are self-transfers back to the operator. This proves the transaction path
(a real bond deposit and a real slash payout each land and confirm on testnet),
not the economics of an independent bond-escrow account or challenger.
[bond-slash] posting bond: 0.02 HBAR, 0.0.9695801 -> 0.0.9695801
[bond-slash] bond submitted, bondRef=bond-1-0.0.9695801@1784930203.231787552 txId=0.0.9695801@1784930203.231787552
  poll #5 at 4141ms: success
[bond-slash] bond confirmed=true settle_time_ms=4540
[bond-slash] HashScan (bond): https://hashscan.io/testnet/transaction/0.0.9695801@1784930203.231787552
[bond-slash] slashing 0.01 of 0.02 HBAR bond to challenger: 0.0.9695801 -> 0.0.9695801
[bond-slash] slash submitted, txId=0.0.9695801@1784930208.924202863
  poll #5 at 4148ms: success
[bond-slash] slash confirmed=true settle_time_ms=4658
[bond-slash] HashScan (slash): https://hashscan.io/testnet/transaction/0.0.9695801@1784930208.924202863
```

Verified on the mirror node (`GET /api/v1/transactions/{id}`): both
`result=SUCCESS`, `charged_tx_fee=140061` tinybar (~0.0014 HBAR) each, same
order of magnitude as `pay`'s fee.

**Bond settled in 4.54s, slash in 4.66s** wall clock, consistent with `pay`'s
4.1s: all three are the same `TransferTransaction` shape, so the settle time is
dominated by the same ~3s consensus + mirror-node ingestion lag, not by which
`PaymentsPort` method issued it.

**Only a self-transfer was exercised** (there is no second funded testnet
account): both `postBond` and `slash` sent `0.0.9695801 -> 0.0.9695801`. The
mirror node's transfer list for each transaction shows only the network fee
(`0.0.9695801 -> 0.0.802`, the node account); the bond/slash amount nets to
zero because sender and receiver are the same account, so no separate transfer
line survives netting. That is expected and it is exactly what "prove the
transaction path, not the economics" (per the issue) means here: the
transaction itself is real, signed, submitted, and finalized on testnet by the
real `@hashgraph/sdk` client, but with only one account there is no genuine
second party for the bond/slash amount to land in. Set
`SPIKE_BOND_ACCOUNT_ID` / `SPIKE_CHALLENGER_ACCOUNT_ID` to a second testnet
account once one exists to see a real net transfer.

### The operator key trap, and why there is a preflight

`PrivateKey.fromString()` does not detect the curve. Given a bare 32-byte hex
string it parses it as ED25519 and returns a valid key that is simply not
yours. Construction succeeds, and the failure surfaces later at the network as
`INVALID_SIGNATURE`, which reads like a permissions problem.

This is not hypothetical: it is exactly what happened on the first live run.
The portal issues ECDSA accounts by default, `fromString` produced the ED25519
reading of the same bytes, and every node rejected the transfer.

So `parseOperatorKey` never guesses silently (DER names its own curve, bare hex
defaults to ECDSA, and `HEDERA_KEY_TYPE` overrides), and `scripts/spike.ts`
calls `assertKeyMatchesAccount` first, comparing the derived public key against
the one the account publishes on the mirror node. A wrong key now fails at
startup with a message naming the curve you wanted, before anything is signed.

### Still unproven

- Every live run so far (`pay`, `postBond`, `slash`) has been a self-transfer,
  because only one funded testnet account exists. A real second account as the
  payee/bond-escrow/challenger is untested (set `SPIKE_PAY_TO_ACCOUNT_ID` /
  `SPIKE_BOND_ACCOUNT_ID` / `SPIKE_CHALLENGER_ACCOUNT_ID`).

If you see a stray `undefined` line on stdout when running via
`pnpm --filter @assay/payments exec tsx scripts/spike.ts` and it fails, check
stderr: that `undefined` comes from pnpm's own `--filter ... exec` failure
reporting (reproduced with an unrelated script), not from this code.

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

## Running the bond/slash script once credentials exist

```
pnpm --filter @assay/payments exec tsx scripts/bond-slash.ts
```

Same `.env` as the spike. Posts a small bond (0.02 HBAR by default, override
with `SPIKE_BOND_AMOUNT_HBAR`) to itself, confirms it, then slashes part of it
(half the bond by default, override with `SPIKE_SLASH_AMOUNT_HBAR`) to itself
as a stand-in challenger (override `SPIKE_BOND_ACCOUNT_ID` /
`SPIKE_CHALLENGER_ACCOUNT_ID` once a second testnet account exists), confirming
that too. Prints both settle times and both HashScan links.

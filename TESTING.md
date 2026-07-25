# Testing Assay

Ordered from fastest and safest to slowest and most fragile, so that when something breaks
you already know which of the three networks to blame. Every command here has been run and
watched succeed; nothing is written from memory.

**If you are reviewing this and do not have testnet credentials**, levels 0 and 1 run with
no network at all, and the "Verifying the claims without running anything" section at the
bottom lets you check the on-chain evidence directly.

## Setup

```bash
eval "$(~/.local/bin/mise activate bash)"   # mise is not loaded in non-interactive shells
pnpm install
```

Levels 2 and up need a `.env` at the repo root (see `.env.example`): a Hedera testnet
operator account, a Sepolia RPC and a funded wallet that owns an ENS name, and a Graph
Studio API key. `AGENTS.md` covers what each one is for.

One thing that will otherwise cost you an hour: the Hedera portal issues **ECDSA** accounts
by default, and `PrivateKey.fromString()` silently misparses a bare hex key as ED25519 and
returns a valid key that is not yours. Everything here goes through `parseOperatorKey`
instead. Set `HEDERA_KEY_TYPE=ecdsa` if you are unsure. See `FEEDBACK.md`.

---

## Level 0 — the whole suite, offline, ~15s

```bash
pnpm -r typecheck && pnpm -r test
```

284 tests across 9 packages. No network, no credentials. If this is red, stop here.

## Level 1 — the narration, offline

```bash
pnpm --filter @assay/dashboard exec tsx src/index.ts slash 0    # the climax
pnpm --filter @assay/dashboard exec tsx src/index.ts happy 0    # the honest path
```

The trailing argument is the delay between steps in milliseconds; use `1500` to watch it at
demo pace. These replay recorded event sequences with no network, which makes them the one
rehearsal that survives dead conference wifi.

In the `slash` run, look for the staged-work disclosure banner at the top and the
`██ BOND SLASHED ██` bar. Both are deliberate: SPEC §11 requires the demo to declare that
the lying provider is a tampered harness.

## Level 2 — one network at a time

Run these separately on purpose. A failure then tells you *which* network is down instead
of just that something is.

```bash
# Hedera: pay 0.01 HBAR, confirm via mirror node, print the HashScan link
pnpm --filter @assay/payments exec tsx scripts/spike.ts

# Hedera: post a bond, then slash part of it
pnpm --filter @assay/payments exec tsx scripts/bond-slash.ts

# The Graph: signals pinned to two different blocks, plus an out-of-range block
pnpm --filter @assay/graph exec tsx scripts/smoke.ts

# ENS: write a manifest and read it back (takes 12 to 25 seconds)
SMOKE_LABEL=test pnpm --filter @assay/registry exec tsx scripts/smoke.ts

# ENS: write a reputation record
SMOKE_LABEL=test pnpm --filter @assay/registry exec tsx scripts/smoke-reputation.ts
```

On the Graph run, the signal that matters is `Block-pinning proof: PASS` plus an **explicit**
error for block 1000 rather than a silent fallback to live data. Everything the verifier
does rests on that refusal being loud.

**Pass `SMOKE_LABEL`.** Without it the registry smoke scripts write to `rugscore.assay.eth`
and overwrite the demo's manifest. That has already happened once during development.

## Level 3 — the capability against real mainnet data

```bash
# blue-chip control, expect a low score
pnpm --filter @assay/cap-rugscore smoke 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48

# a real thin token, expect ~100 (see note below on why this drifts)
pnpm --filter @assay/cap-rugscore smoke 0xd6c68bc8c862722e140e7b339ddf8a144a7d3530

# the verifier: an honest result passes, a tampered claim is caught by name
pnpm --filter @assay/cap-rugscore verify-smoke
```

GOODCAT's score is not stable across runs. Its `ageBlocks` is `currentBlock -
createdAtBlockNumber`, computed live every time, and `scoring.ts`'s age signal gives a
non-zero (if tiny) safety credit as that count grows toward `MATURE_AGE_BLOCKS` (200,000
blocks). At the table below's block, that credit rounded away and GOODCAT hit the ceiling of
100; a few thousand blocks later (about an hour) it had already drifted to 99, and it will
keep drifting down by roughly a point every ~10,000 blocks from here. **Treat anything in the
high-90s as a pass**, not just exactly 100; the top row (USDC) is unaffected because its age
signal is already pinned at its floor.

For reference, both queried at the same block (captured once; USDC's row is stable, GOODCAT's is not, see above):

| token | score | liquidity | age | txs | top-pool concentration |
|---|---|---|---|---|---|
| USDC | 9 | $360,518,349 | 13,235,876 blocks | 36,491,026 | 43.9% |
| GOODCAT | 100 | **$57** | 3,259 blocks | **2** | 100% |

`verify-smoke` is the most important check in the project. It must print
`badClaim: "liquidityUsd"` with the claimed and actual values side by side, and it must also
pass the case where an honest provider's claims are re-verified after the chain has moved.
That second case is what stops honest providers being slashed on data drift.

## Level 4 — the provider and its payment gate

```bash
pnpm --filter @assay/provider exec tsx src/index.ts
```

It boots against named fakes and says so, so this level needs no credentials. In another
shell, the interesting case is the refusal:

```bash
curl -X POST localhost:8787/serve -H 'content-type: application/json' \
  -d '{"provider":"rugscore.assay.eth","capabilityId":"rugscore","request":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","txId":"never-paid"}'
```

Expect **402** `payment_not_confirmed`. If a result ever comes back without a confirmed
payment, the gate is broken and the Hedera integration means nothing. A malformed body
returns **400** before any payment work happens.

## Level 5 — the full loop, live, both directions

```bash
pnpm --filter @assay/watchdog exec tsx src/index.ts lying    # challenge upheld, bond slashed
pnpm --filter @assay/watchdog exec tsx src/index.ts honest   # challenge fails, nothing slashed
```

**Run both.** The first shows a liar being punished. The second shows the system is not
rigged: a verifier that always returns FALSE proves nothing about verification. Same code
path, outcome decided by the verifier.

About 24s each. They target `liar.assay.eth`, not the good provider, so rehearsing the
climax does not damage the record the demo's opening depends on. Override with
`WATCHDOG_PROVIDER_NAME` if you need to.

## Level 6 — the real requester agent

```bash
bash -lc 'pnpm --filter @assay/mcp agent:live'
```

The `bash -lc` is not optional. `CLAUDE_CODE_OAUTH_TOKEN` lives in `~/.bashrc`, so a
non-login shell fails with `Not logged in`.

Takes 42 to 57 seconds, mostly the agent thinking, and should end `VERDICT: PAID`. The two
fixture runs are the ones that prove there is no hidden branch:

```bash
bash -lc 'pnpm --filter @assay/mcp agent:bad-provider'   # -> DECLINED
bash -lc 'pnpm --filter @assay/mcp agent:good-provider'  # -> PAID
```

One prompt (`apps/mcp/agent/prompt.md`, which sets a goal and a budget and never says
whether to pay), three providers, three outcomes the model reached on its own. Transcripts
land in `apps/mcp/agent/transcripts/` and previous ones are committed.

## Before every rehearsal

```bash
pnpm --filter @assay/registry exec tsx scripts/reset-demo-state.ts
```

Takes ~25s and must end with `read-back matches target: OK`. Reputation records are real, so
every rehearsal changes them; without a reset the agent correctly declines to pay and the
demo's opening beat cannot happen. Do not run it on stage.

`docs/demo-run-sheet.md` has the full checklist and the measured timings the running order
is built on.

---

## When it breaks

| symptom | cause |
|---|---|
| `INVALID_SIGNATURE` | the Hedera key was parsed on the wrong curve. Use `parseOperatorKey`, set `HEDERA_KEY_TYPE=ecdsa` |
| `Not logged in` | missing `bash -lc`, so `CLAUDE_CODE_OAUTH_TOKEN` was not inherited |
| `pnpm: command not found` | missing `eval "$(~/.local/bin/mise activate bash)"` |
| the agent declines to pay | reputation damaged by an earlier rehearsal. Run the reset |
| ENS appears frozen for 20s | it is not. Writes take 12 to 25 seconds |
| `MissingRecordError` on `assay:rep` | a name that was never initialised, not a corrupt record |
| a name looks unregistered | do not trust the `.eth` BaseRegistrar, it is legacy here. Trust `resolveName` |

## Verifying the claims without running anything

Everything this project asserts is checkable from public data, which is the point.

**The Hedera transactions.** Every payment, bond and slash is on HashScan. Pull one up and
check the memo: a payment carries its `requestHash`, which is what binds it to the request
the provider served.

```
https://hashscan.io/testnet/transaction/0.0.9695801@1784929785.951608160
```

**The ENS records.** Read them straight off the resolver rather than trusting anything here.
This is the exact snippet used to verify every ENS claim in this repo, run from the repo root
with a Sepolia RPC in `.env`:

```bash
pnpm --filter @assay/registry exec node --input-type=module -e '
import { ethers } from "ethers";
const p = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
const r = await p.getResolver("rugscore.assay.eth");
console.log(await r.getText("assay:manifest"));
console.log(await r.getText("assay:rep"));'
```

Note that `assay.eth` and its subnames resolve through a wildcard resolver, so the subnames
have no entry in the ENS registry at all. Querying `owner()` for `rugscore.assay.eth` returns
the zero address while its text records read perfectly. That is expected, not a broken
record. `FEEDBACK.md` has the detail.

**The verifier commitment.** The manifest's `verifierHash` is a real sha256 over the two
files that decide a verdict, and it is reproducible with standard tools:

```bash
cd packages/cap-rugscore/src
for f in rugscore.ts tolerances.ts; do printf '%s\n%s\n' "$f" "$(stat -c%s $f)"; cat "$f"; done | sha256sum
```

That must equal the `verifierHash` published on chain. It covers `verify()` and the
tolerances, and deliberately excludes scoring, because a tolerance change silently changes
verdicts while a scoring change cannot. See `packages/cap-rugscore/src/verifier-hash.ts`.

**The Graph queries.** Any block-pinned query is reproducible against the gateway with your
own Studio key. Ask for the same token at two different blocks and the values differ; ask
for a block before the subgraph's start block and it refuses rather than substituting live
data.

# Assay

A reputation and payment rail for agent-to-agent services. **ENS is the business
card, Hedera is the cash register, and reputation is _assayed_ against The Graph,
not rated.**

Built at **ETHGlobal Lisbon 2026**.

## The problem

As autonomous agents start transacting with each other (x402, the agent economy),
three primitives are missing: **discovery** (how do I find an agent that offers a
service?), **trust before payment** (is this stranger competent and honest?), and a
cheap, fast **micro-payment** rail. There is no portable, verifiable reputation an
agent can check before it pays.

## The idea

Assay is a generic rail over **verifiable** capabilities:

- A provider agent publishes a capability (what it does, price, endpoint) and its
  reputation as **ENS text records**, and posts a **bond** on-chain.
- A requester agent **resolves the ENS name**, reads the manifest and reputation,
  and decides whether to pay based on it.
- It **pays per call on Hedera** (sub-second settlement).
- The result carries **factual, block-stamped claims**. Anyone can **challenge** a
  claim; a **verifier** re-derives it from **The Graph** at the same block. If the
  provider lied, its **bond is slashed** and its ENS reputation drops.

Reputation is not a subjective star rating. It reflects whether a result passed an
**objective verifier**. Bad answers are provably punished. The demo instantiates one
concrete capability, **rug-pull risk scoring**, chosen because it is expensive to
compute but cheap to spot-check.

## How it works

```
discover (ENS) -> check reputation (ENS) -> pay (Hedera) -> serve (The Graph)
   -> challenge -> verifier re-derives from The Graph -> slash + reputation update (ENS)
```

Three independent networks, no bridge, orchestrated by the Assay node (which is also
an MCP server a real Claude agent drives live):

- **The Graph** (mainnet, read-only): the source of truth for scores and verification,
  read through **block-pinned subgraph queries** so a claim can be re-derived at exactly
  the block it was stamped at.
- **Hedera** (testnet): pay, bond, slash, and **anchor**. The loop's own event log is
  hash-chained to a consensus topic, so the run's narration is checkable too.
- **ENS** (Sepolia): identity manifest and portable reputation in text records.

## Prize tracks (ETHGlobal Lisbon 2026)

- **Hedera**: AI & Agentic Payments
- **The Graph**: Best AI Use Case
- **ENS**: Best Integration for AI Agents

## Repo layout

```
packages/   core, registry (ENS), payments (Hedera), graph (The Graph), cap-rugscore
apps/       mcp (the server, nine tools), provider, watchdog, dashboard
```

## Running the demo

Open **Claude Code** in this repo and run **`/assay-demo`**. `.mcp.json` registers the `assay`
server, so a real session drives the real loop and renders its own reasoning and tool calls.

```bash
./scripts/demo.sh    # reset the two providers' opening state first (~57s)
claude               # then /assay-demo
```

Before the live run, `docs/pitch/index.html` is the two-minute explainer for the people
watching: what this is, what each network is doing and why. One self-contained file, no
build and no network, and printing it gives a two-page handout. See
[`docs/pitch/README.md`](docs/pitch/README.md).

There is no custom demo application, deliberately. Two earlier attempts were built and
deleted, and the reason is worth stating: **a renderer we write is less credible than the tool
the audience already uses.** A judge cannot verify that our screen showed them the truth. In
Claude Code they see the MCP server badge, the real tool names, the arguments, and the raw
JSON that came back.

`.claude/commands/assay-demo.md` holds the prompt. It sets a goal and a budget and never names
the provider to distrust, the claim to check, or when to challenge.

For a run with no network at all, `pnpm --filter @assay/dashboard exec tsx src/index.ts slash`
replays a captured run.

## What actually works

Every step below has been executed against live networks, not simulated. Transaction ids
and the reasoning behind each design choice are in the pull requests.

| | |
|---|---|
| **Hedera testnet** | pay, bond and slash are real transactions. A payment binds its `requestHash` into the transaction memo, and the provider serves only after the mirror node confirms it. |
| **The Graph** | `getTokenSignals(token, atBlock)` issues block-pinned subgraph queries. Two different blocks return genuinely different values, and a block outside the indexed range fails loudly rather than silently returning live data. |
| **ENS on Sepolia** | `assay:manifest` and `assay:rep` are live text records. Reputation writes are real; nothing is cached and presented as written. |
| **The verifier** | re-derives each claim at that claim's own `atBlock` and compares within per-signal tolerances. |
| **The agent** | a real Claude Code session drives the loop through the MCP server's nine tools and decides for itself whether to pay, whether to verify, and whether to challenge. |
| **The audit trail** | every line of the loop's event log is folded into a SHA-256 chain whose head is submitted to a **Hedera Consensus Service topic** at each turning point. Anyone can replay the log, recompute the chain and compare it against consensus ordering, with no credentials of ours. |

The loop has run end to end, in both directions, on all three networks:

```
lying provider   challenge upheld  -> bond slashed on Hedera, ENS reputation 56 -> 26
honest provider  challenge failed  -> no bond touched,        ENS reputation 26 -> 31
```

The second run is the one that matters. A system that only ever confirms a lie proves
nothing about its verifier.

### The agent genuinely decides

`.claude/commands/assay-demo.md` gives the agent a goal and a budget and never tells it
whether to pay. Same prompt, three providers, three outcomes it reached on its own: `DECLINED`
against a provider with slashes, `PAID` against a clean one. Transcripts are committed in
`apps/mcp/agent/transcripts/`.

On the declining run it went past what was asked, noticing the bond was only 1.00x the
price and reasoning that lying is therefore roughly break-even for the provider, so there
is no deterrent, "which is presumably how the slash ratio got to 33% in the first place".
It then declined to use the available override on the grounds that it agreed with the
policy rather than being blocked by it.

### Real vs staged

Stated plainly because a submission that hides this deserves to lose:

**Real.** Every value transfer on Hedera (payment, bond, slash) is a real, signed,
submitted, mirror-node-confirmed transaction. Every ENS read and write. Every Graph
query, against mainnet data. The verifier's logic. The MCP server and the Claude agent
driving it.

**Value moves between two distinct accounts.** For most of the build there was only
one funded testnet account, so every Hedera transfer was a self-transfer: real
transactions, but the amount netted to zero and nothing left the operator's control net
of fees. That was disclosed here, and it turned out to matter more than as a disclosure.
When the payment gate started verifying the amount, the loop broke: **the mirror node
reports a self-transfer as only the fee movement**, so the payment never appears in the
transfer list and no amount check can pass on one. Every unit test passed, because the
fakes model a transfer that does not net out. Only the live run showed it.

The fix was a second account
(`packages/payments/scripts/create-account.ts`), not a weaker check. A payment now reads:

```
0.0.9695801  -5.00143077 HBAR
0.0.9743633  +5 HBAR
```

which is what makes verifying the amount meaningful in the first place.

**Staged, and disclosed on screen when it runs.** The "lying provider" is
`createLyingRugScoreProvider`, a deliberately tampered test harness that runs the real
capability and alters exactly one claim. The watchdog's *timing* is scripted: it is told
which job and claim to look at, where a real watchdog would decide on its own when to
challenge. The challenge, the verifier, the slash and the ENS write in that path are all
real.

**The manifest's `endpoint` is a local address the demo never dials.** SPEC §4 models a
provider as a separate long-running service, and `apps/provider` is that service: it works, and
its payment gate returns 402 without a confirmed payment. But the MCP server runs the
capability in-process, because a demo that needs a second process up has one more thing that
can be down on stage. So the field is truthful (that is where the provider serves when it runs)
and not load-bearing here. Making it a public URL we do not actually serve would be the worse
lie.

**Honest gaps.** A failed challenge should also cost the challenger a deposit (SPEC §7);
there is no escrow to forfeit, so only the reputation half exists. Settlement is not
atomic across three networks and the code does not pretend it is: the job's status is
recorded before the ENS write, so a failed write leaves a truthful status and a named
error. The demo runs one provider and one capability.

### Measured timings

Worth knowing before believing any "instant" claim about either chain:

| | |
|---|---|
| Hedera payment, submit to mirror-node confirmed | **~4.1s** |
| Hedera slash, transfer alone | **~0.4s** |
| Hedera consensus anchor, submit to receipt, 12 samples | **1.0s to 2.5s**, median ~1.7s |
| ENS text-record write, samples across two rehearsals | **8.3s to 24.6s**, median ~13s |

The ENS spread is wide and does not converge, which matters more to a demo run sheet than
the median does; a later rehearsal pushed the low end down from 12.4s to 8.3s, which widens
the range rather than narrowing it. See `docs/demo-run-sheet.md`.

### The log is checkable too

Every factual claim in this project is re-derivable by a stranger: the Graph queries are
block-pinned, the ENS records are public, the Hedera transfers are on a public mirror node.
The event log was the one artefact left that asked to be believed, because it is a file on
my disk that I could have rewritten afterwards. That is exactly the standard this project
accuses star ratings of failing, so it should not get a pass for being mine.

So the sink folds every line it writes into a SHA-256 chain, and submits the head of that
chain to a **Hedera Consensus Service topic** at each turning point of the loop: `pay`,
`serve`, `challenge`, `verify`, `slash`, and once at close for the tail. Six messages cover
a whole run, they carry 64 hex characters rather than anyone's job data, and a match proves
more than a copy would: not just that those events existed, but that no line anywhere before
the anchor was added, removed, reordered or edited, because any of those reshuffles every
hash after it.

```bash
pnpm --filter @assay/mcp exec tsx scripts/verify-anchors.ts \
  --topic 0.0.9753542 --file docs/evidence/anchored-runs.ndjson
```

That check needs none of my credentials, and nothing of mine has to be running: the log is
committed at [`docs/evidence/anchored-runs.ndjson`](docs/evidence/anchored-runs.ndjson) and
the mirror node is public. It is the same command whether it agrees or not. On that file,
which holds two live runs anchored to topic
[`0.0.9753542`](https://hashscan.io/testnet/topic/0.0.9753542), it reports `12/12 anchors
reproduce from this file`, one row per anchor with the consensus timestamp Hedera assigned
it. Change a single `amountHbar` in a copy and it drops to `8/12` and exits non-zero, with
each run's last two anchors flipping to `MISMATCH` independently. The boundary is itself
informative: it locates the edit to after seq 9 in each run.
[`docs/evidence/README.md`](docs/evidence/README.md) has both commands.

One thing that took a second pass to get right. The topic id lives in `.env`, so a single
topic carries anchors from every run while any one log file holds a subset of them. The
first version matched an anchor to whichever segment reproduced it and called the rest
mismatches, which meant the second run reported six failures for a log that was perfectly
intact. That is worse than a missing feature, because it teaches the reader to ignore
`MISMATCH`, which is the one word here that has to mean something. So each run now writes a
header line with a random run id and every anchor carries it: an anchor from another run is
skipped and counted separately, and only an anchor that belongs to this file and fails to
reproduce is a mismatch.

What this does not prove is that the events were true when written. That is what the claim
verifier and The Graph are for. It proves only that the record was not edited afterwards,
which is the part that used to rest on my word.

## Impact on the Hedera network

Measured per job from the live runs, not projected:

| | |
|---|---|
| Provider onboarding | 1 Hedera account, 1 bond transfer, one-off |
| A paid job, no challenge | 1 transfer + 3 consensus messages = **4 transactions** |
| A paid job, challenged and slashed | 2 transfers + 6 consensus messages = **8 transactions** |

The anchoring is what makes that multiplier 4 to 8 rather than 1, and it scales with the
number of loop events rather than with the value moved, so it holds at any price point. A
sub-cent call generates the same transaction count as a large one.

Being straight about the size of it: at 100 providers each serving 100 calls a day, that is
10,000 jobs and roughly 40,000 transactions a day, about **0.46 TPS** sustained. That is
real traffic and it is not a large number. Reaching 1,000 TPS would take on the order of 20
million jobs a day, which is not a claim I am going to make from a hackathon. The honest
version of the argument is the multiplier and the shape, not a headline figure.

Two things about the shape are worth more than the number. First, every provider needs its
own Hedera account to receive payment and hold a bond, so account growth is linear in supply
rather than in demand, and supply is the side I would onboard by hand. Second, the
distribution surface is an MCP server: a Claude Code user adds one line to a config file and
then watches real Hedera transaction ids scroll past in their own terminal, which is
exposure to an audience that is not otherwise looking at Hedera at all.

## Feedback so far

Two cycles are running, and neither is a survey.

[`FEEDBACK.md`](FEEDBACK.md) is a full report to the three sponsors written from things that
actually cost me time: an SDK footgun in `PrivateKey.fromString` that nearly ended the
project two hours in, a block-filtering limitation in The Graph's Token API that made me
switch to the gateway, and ENS write latency measured across seven real confirmations. Every
item carries the measurement or the error message that established it, and two of them
changed this build rather than just being written down.

The agent is the other one. The demo prompt sets a goal and a budget and never names the
provider to distrust or when to challenge, so each run observes whether the interface is
legible to the only kind of user this thing has. It has already returned a finding I would
not have got by inspection: it declined a provider because the bond was only 1.00x the
price, reasoning that lying is therefore break-even so the deterrent is absent. That is
feedback on the bond-sizing parameter, from the buyer.

What there is not: external users, paid trials, revenue. Ten provider interviews are the
next cycle and they have not happened.

## Beyond the hackathon

- [`docs/business-model.md`](docs/business-model.md) is the Lean Canvas: who pays, why this
  cannot be a Web2 product, and why verification cost rather than payment cost is the thing
  that decides which capabilities are viable.
- [`docs/roadmap.md`](docs/roadmap.md) is what I would build next, in what order, with the
  go to market and the feedback cycles behind it. The first phase is entirely about closing
  gaps I already know about, starting with the challenger deposit.

## Reproducing this

`TESTING.md` walks through every check, ordered so a failure tells you which of the three
networks to blame. Levels 0 and 1 need no network at all. It also has a section on verifying
the on-chain claims directly, without running anything.

## Status

Built over a 36 hour hackathon by one person with Claude Code. The detailed design doc is
kept private; this README is the public overview.

## License

MIT. See [LICENSE](LICENSE).

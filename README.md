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
- **Hedera** (testnet): pay, bond, slash.
- **ENS** (Sepolia): identity manifest and portable reputation in text records.

## Prize tracks (ETHGlobal Lisbon 2026)

- **Hedera**: AI & Agentic Payments
- **The Graph**: Best AI Use Case
- **ENS**: Best Integration for AI Agents

## Repo layout

```
packages/   core, registry (ENS), payments (Hedera), graph (The Graph), cap-rugscore
apps/       mcp (server), provider, watchdog, dashboard
```

## What actually works

Every step below has been executed against live networks, not simulated. Transaction ids
and the reasoning behind each design choice are in the pull requests.

| | |
|---|---|
| **Hedera testnet** | pay, bond and slash are real transactions. A payment binds its `requestHash` into the transaction memo, and the provider serves only after the mirror node confirms it. |
| **The Graph** | `getTokenSignals(token, atBlock)` issues block-pinned subgraph queries. Two different blocks return genuinely different values, and a block outside the indexed range fails loudly rather than silently returning live data. |
| **ENS on Sepolia** | `assay:manifest` and `assay:rep` are live text records. Reputation writes are real; nothing is cached and presented as written. |
| **The verifier** | re-derives each claim at that claim's own `atBlock` and compares within per-signal tolerances. |
| **The agent** | a real headless Claude agent drives the loop through the MCP server and decides for itself whether to pay. |

The loop has run end to end, in both directions, on all three networks:

```
lying provider   challenge upheld  -> bond slashed on Hedera, ENS reputation 56 -> 26
honest provider  challenge failed  -> no bond touched,        ENS reputation 26 -> 31
```

The second run is the one that matters. A system that only ever confirms a lie proves
nothing about its verifier.

### The agent genuinely decides

`apps/mcp/agent/prompt.md` gives the agent a goal and a budget and never tells it whether
to pay. Same prompt, three providers, three outcomes it reached on its own: `DECLINED`
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
| ENS text-record write, samples across two rehearsals | **8.3s to 24.6s**, median ~13s |

The ENS spread is wide and does not converge, which matters more to a demo run sheet than
the median does; a later rehearsal pushed the low end down from 12.4s to 8.3s, which widens
the range rather than narrowing it. See `docs/demo-run-sheet.md`.

## Reproducing this

`TESTING.md` walks through every check, ordered so a failure tells you which of the three
networks to blame. Levels 0 and 1 need no network at all. It also has a section on verifying
the on-chain claims directly, without running anything.

## Status

Built over a 36 hour hackathon by one person with Claude Code. The detailed design doc is
kept private; this README is the public overview.

## License

MIT. See [LICENSE](LICENSE).

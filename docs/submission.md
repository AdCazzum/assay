# Assay — ETHGlobal Lisbon 2026 submission copy

Draft submission copy for the ETHGlobal form. Written in first person because it goes
under my name. Adapt freely, but keep the numbers as measured: every figure here is
something a judge can reproduce, and that is the point of the project.

---

## 1. Short description

Assay is a reputation and payment rail for agent-to-agent services: a provider agent
publishes what it does and its track record as ENS text records and posts a bond, a
requester agent resolves the name, reads the reputation, and decides for itself whether
to pay per call on Hedera. Results carry block-stamped factual claims; anyone can
challenge one, a verifier re-derives it from The Graph at the same block, and if the
provider lied its bond is slashed and its ENS reputation drops.

## 2. Full description

**The problem.** As agents start paying other agents for services (x402, the wider agent
economy), three things are missing: a way to discover who offers what, a way to decide
whether a stranger is competent and honest before paying them, and a cheap, fast
micro-payment rail. Star ratings do not solve the trust problem, because they are
opinions. I wanted reputation that reflects whether a result actually held up, not
whether someone liked it.

**The idea.** Assay is a generic rail over capabilities that can prove themselves:

- A provider agent publishes a capability (what it does, price, endpoint) and its
  reputation as ENS text records, and posts a bond on-chain.
- A requester agent resolves the ENS name, reads the manifest and the reputation, and
  decides whether to pay based on what it reads. Nothing forces the decision either way.
- Payment is per call, on Hedera testnet.
- The result carries factual, block-stamped claims (a token's liquidity, its age in
  blocks, its transaction count, all pinned to a specific block number). Anyone can
  challenge a claim; a verifier re-derives it from The Graph at that exact block. If the
  provider lied, its bond is slashed and its ENS reputation is written down.

Reputation here is not a star rating, it is the outcome of a check. Bad answers get
punished in a way anyone can audit afterward. The demo instantiates one concrete
capability, rug-pull risk scoring for an ERC-20 token, because it has the right shape:
expensive to compute well, cheap to spot-check.

**How it works.**

```
discover (ENS) -> read reputation (ENS) -> pay (Hedera) -> serve (The Graph)
   -> challenge -> verifier re-derives from The Graph -> slash + reputation update (ENS)
```

Three independent networks, no bridge between them, coordinated off-chain by the Assay
node, which is also the MCP server a live Claude agent drives on the requester side:

- **The Graph** (mainnet, read-only) is the source of truth: block-pinned Uniswap v3
  subgraph queries, so a claim can be re-derived at exactly the block it was stamped at.
- **Hedera** (testnet) handles pay, bond and slash.
- **ENS** (Sepolia) holds the capability manifest and the portable reputation record.

**What is real.** Every Hedera transaction (pay, bond, slash), every ENS read and write,
every Graph query against live mainnet data, the verifier's comparison logic, and the MCP
server with a real Claude agent deciding whether to pay, are real and have run end to end
against live networks, in both directions (an honest provider that keeps its bond, and a
provider that lies and gets slashed). Section 5 below is the honest account of what is
staged and what is still a gap, because a submission that hides that is not one I want to
put my name on.

## 3. Track write-ups

### Hedera — AI & Agentic Payments

**What the integration does.** A requester pays per call on Hedera testnet before a
result is served, using `pay(amount, requestHash)`; the payment's transaction memo
carries the request hash, so a specific payment can be tied back to a specific request
by anyone looking at the transaction. The provider only serves after
`confirm(txId)` reports the transaction settled on the mirror node. Separately,
`postBond` and `slash` move real HBAR on the same rail: a provider posts a bond when it
registers, and a successful challenge slashes part of it.

**Why it is load-bearing, not decorative.** The pay decision is the thing the requester
agent actually reasons about: it reads the ENS reputation first and only then decides
whether the price is worth it. In one recorded run, the same prompt and the same budget
produced `DECLINED` against a provider carrying past slashes and `PAID` against a clean
one, with no hardcoded branch choosing the outcome (transcripts in
`apps/mcp/agent/transcripts/`). The slash is what gives the bond teeth: without a real
transfer, "reputation" would just be a number nobody has to back up.

**Evidence a judge can check.**
- A payment's HashScan link, e.g. `https://hashscan.io/testnet/transaction/0.0.9695801@1784929785.951608160`.
  Open it, decode the memo, and it is the request hash the provider was paid to serve.
- Measured settlement: a payment resolves in about 4.1 seconds from submit to a
  mirror-node-confirmed `SUCCESS`; an isolated transfer (no confirmation wait) resolves
  in about 0.4 seconds. Both numbers are worth knowing before planning a demo around
  either chain's "instant" marketing.
- `packages/payments/README.md` has the full transcript of a live `postBond` + `slash`
  round trip against testnet, including the HashScan links for both transactions.

**Value genuinely leaves the payer.** For most of the build only one funded testnet
account existed, so every pay, bond and slash was a self-transfer: real signed
transactions, but the amount netted to zero and nothing left the operator's control
beyond fees. That was disclosed rather than hidden, and it turned out to matter for a
second reason nobody predicted. When the payment gate started verifying the amount, the
loop broke: **the mirror node reports a self-transfer as only the fee movement**, so the
payment never appears in the transfer list and no amount check can pass on one. Every
unit test passed; only the live run showed it.

The fix was a second funded account, not a weaker check. A payment now reads:

```
0.0.9695801  -5.00143077 HBAR
0.0.9743633  +5 HBAR
```

which is what makes verifying an amount meaningful in the first place.

**Two Hedera services, and the second one is the non-obvious use.** Payments are HBAR
transfers. The audit trail is the **Hedera Consensus Service**, and it attests the one
artefact that was still asking to be trusted. Every other claim this project makes is
re-derivable by a stranger: the Graph queries are block-pinned, the ENS records are
public, the transfers are on a public mirror node. The loop's event log was not. It is a
file on my disk, and I could have rewritten it after the run, which is exactly the
standard the project accuses star ratings of failing.

So the sink folds every line it writes into a SHA-256 chain and submits the head of that
chain to a topic at each turning point of the loop (`pay`, `serve`, `challenge`, `verify`,
`slash`, and once at close for the tail). It is deliberately not a copy of the events onto
the topic: six ~100-byte messages cover a run of any length, they leak no job data, and a
match proves strictly more than a copy would. A copy shows those events existed; a chain
head shows that **no line anywhere before it was added, removed, reordered or edited**,
because any of those reshuffles every hash after it. The consensus timestamp is Hedera's,
so *when* that state existed is attested too, and a log rewritten later cannot produce
anchors that were already stamped mid-run.

**Evidence a judge can check, with no credentials of mine.** Topic
[`0.0.9753542`](https://hashscan.io/testnet/topic/0.0.9753542):

```bash
pnpm --filter @assay/mcp exec tsx scripts/verify-anchors.ts \
  --topic 0.0.9753542 --file docs/evidence/anchored-runs.ndjson
```

That log is committed, so this runs on a fresh clone with nothing of mine up. It holds
two live runs of the anchoring path and prints `12/12 anchors reproduce from this file`,
one row per anchor with the consensus timestamp Hedera assigned it. Change a single
`amountHbar` in a copy and the same command gives `8/12`, exit code non-zero, with each
run's last two anchors flipping to `MISMATCH` independently and the boundary locating the
edit to after seq 9 in each. `docs/evidence/README.md` has both commands verbatim. The raw
messages are readable straight off the public mirror node at
`https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.9753542/messages`.

**One bug worth admitting, because it is the interesting one.** The topic id lives in
`.env`, so a single topic carries anchors from every run while any one log holds a subset.
The first verifier matched an anchor to whichever run reproduced it and called the rest
mismatches, which meant the second run against a topic reported six failures for a log
that was perfectly intact. Unit tests did not catch it, because a single-run fixture
cannot express the case. It is a smaller instance of the same lesson this repo keeps
relearning, and it mattered more than a cosmetic bug would: a verifier that cries wolf
teaches its reader to ignore the one word in the output that has to mean something. The
fix is a run id in the header line and in every anchor, so "belongs to another run" and
"belongs to my run and does not reproduce" cannot look alike.

Anchoring costs 1.0s to 2.5s per message from submit to receipt (12 samples, median
~1.7s), and it runs off the hot path: a topic outage costs a run its audit trail, never
its payment.

### The Graph — Best AI Use Case

**What the integration does.** `getTokenSignals(token, atBlock)` issues block-pinned
queries against a Uniswap v3 subgraph through the Graph gateway, returning the signals
the rug-score capability's claims are built from: liquidity in the token's deepest pool,
age in blocks, transaction count, cumulative volume, and top-pool concentration. Every
signal is read at a specific block number, not "current state."

**Why it is load-bearing, not decorative.** The Graph is not just an input the provider
uses to compute a score once; it is what the verifier queries again, independently, at
the exact same block, when a claim is challenged. That re-derivation is the entire
mechanism that makes the reputation system mean anything: if a provider's claim does not
match what The Graph says was true at that block, the verifier catches it and the bond
gets slashed. A block outside the subgraph's indexed range fails loudly rather than
silently returning live data, which is the property a verifier needs: a silent fallback
to "whatever is true now" would slash honest providers every time the chain moves.

**Evidence a judge can check.**
- Two real tokens, queried at the same block: USDC (`0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`)
  carries about $360.5 million of liquidity in its deepest pool and 36.5 million
  transactions, and scores low risk. GOODCAT (`0xd6c68bc8c862722e140e7b339ddf8a144a7d3530`)
  is a real, thin token: $57 in its only pool and 2 transactions, and scores at the top
  of the risk scale. Because the score is computed live off current chain state (age in
  particular keeps advancing), the exact number can drift by a point from what any
  fixed table says; the $57-liquidity, 2-transaction facts underneath it do not move.
- `pnpm --filter @assay/cap-rugscore smoke <address>` runs this against live mainnet
  data and prints the claims. `pnpm --filter @assay/cap-rugscore verify-smoke` runs the
  verifier against a tampered claim and must print the exact bad claim key
  (`liquidityUsd`) with the claimed and actual values side by side.
- Asking for a block before the subgraph's indexed range returns an explicit refusal
  naming the minimum block, not a silent substitution: `bad query: requested block
  1000, before minimum 'startBlock' of manifest 12369621`.

### ENS — Best Integration for AI Agents

**What the integration does.** Each provider gets a subname under a parent I own
(`rugscore.assay.eth` in the demo). Two text records live there: `assay:manifest`
(capability id, price, endpoint, bond reference, and a `verifierHash` committing to the
verifier's logic) and `assay:rep` (score, job count, slash count, bond). A requester
agent resolves the name and reads both before deciding whether to pay; a successful
challenge writes a new `assay:rep` back.

**Why it is load-bearing, not decorative.** This is the trust surface the whole loop
hinges on: an agent that skipped reading it would be paying blind. Resolving one
human-readable name gets an agent the price, the endpoint, and whether this specific
provider has been caught lying before, in one lookup, with no separate reputation
service to trust. The reputation write closes the loop: a slash is not real to a future
requester unless the public record actually changes.

**Evidence a judge can check.**
- Read the records directly off a Sepolia resolver, no credentials of mine required,
  any Sepolia RPC will do:

  ```bash
  node --input-type=module -e '
  import { ethers } from "ethers";
  const p = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");
  const r = await p.getResolver("rugscore.assay.eth");
  console.log(await r.getText("assay:manifest"));
  console.log(await r.getText("assay:rep"));'
  ```

  (Needs `ethers` installed somewhere on your `NODE_PATH`, or run it from this repo
  after `pnpm install`, where it is already a dependency of `@assay/registry`.)
- The manifest's `verifierHash` is a real sha256 over the two source files that decide a
  verdict, reproducible with `sha256sum`: see `TESTING.md`'s final section for the exact
  command. It must match what the resolver above prints.
- Sub-names resolve and accept writes through a wildcard resolver with no separate
  on-chain registration step per provider: `rugscore.assay.eth` has no entry of its own
  in the ENS registry (its registry owner reads as the zero address), yet its text
  records read and write correctly. That is one transaction to set up the parent name,
  then zero transactions per provider onboarded, which is the property that makes
  per-agent identity practical at all.
- Text-record writes are not fast and do not converge on one number: across measured
  samples, a `setText` confirmation has taken anywhere from 8.3 to 24.6 seconds. That
  spread, not the median, is the number worth knowing if you plan a demo around it.

If you resolve the bare parent name (`assay.eth`) instead of the subname, expect
`assay:rep` to come back unset: the parent is identity for the project, not a live
provider, and the loop's discover/pay path never reads it.

## 4. Seeing it run

Open Claude Code in the repo and run `/assay-demo`. `.mcp.json` registers the `assay`
MCP server, so a real session drives the real loop: it chooses which providers to
consult, which to pay, what to verify and whether to challenge. Nothing is pressed.

We deliberately ship no custom demo application. Two were built and deleted, because a
renderer we write is less credible than the tool the audience already uses: in Claude
Code a judge sees the MCP server badge, the real tool names, the arguments and the raw
JSON that came back, and none of it has to be taken on trust.

The prompt (`.claude/commands/assay-demo.md`) sets a goal and a budget and never names
the provider to distrust, the claim to check, or when to challenge.

A full session is committed at
`apps/mcp/agent/transcripts/2026-07-25-claude-code-session.md`. It is worth reading for
one paragraph in particular, which we did not prompt and could not have written better:

> the two providers' claims were four blocks apart, so a naive side-by-side comparison of
> their outputs would have been unsound reasoning even though it happened to point at the
> right answer. What actually convicted the second provider was re-deriving at its own
> stamped block.

Nobody told the agent that comparing two providers' outputs would be unsound, or that
block-stamping is what makes a verdict safe. It worked that out, flagged it rather than
burying it, and noted that the unsound route would have reached the right answer anyway.
That is this project's central argument, arrived at independently by the thing it was
built for. The reputation changes it reports were checked against the Sepolia resolver
afterwards rather than taken from the transcript.

## 5. How to verify our claims

`TESTING.md`'s final section, "Verifying the claims without running anything," is built
for exactly this: checking the project's claims against public data, without our `.env`
or testnet credentials. Three checks that fit in under a minute each:

1. **The test suite, offline.** `pnpm -r typecheck && pnpm -r test` runs 394 tests
   across 9 packages with no network and no credentials. If this is not green, stop
   there; nothing else matters until it is.
2. **A Hedera transaction, on HashScan.** Open any transaction id cited in this document
   or in `packages/payments/README.md` and check the decoded memo against the request
   hash the provider claims to have served.
3. **An ENS record, off a public resolver.** Run the snippet in the ENS track write-up
   above against `rugscore.assay.eth`, using any Sepolia RPC endpoint (a free public one
   works fine, since this is a plain read). Compare the `verifierHash` it returns against
   `sha256sum` over `packages/cap-rugscore/src/rugscore.ts` and
   `packages/cap-rugscore/src/tolerances.ts` (exact command in `TESTING.md`).

Note that `TESTING.md`'s own one-line ENS snippet assumes `SEPOLIA_RPC_URL` is already
exported into your shell, not just sitting in a `.env` file (that particular script does
not load one). Export it first, or use the self-contained version above.

## 6. What is real and what is staged

This follows the project's own design doc (SPEC.md §11, kept private, but this is a
faithful account of it), plus the gaps I know about and have not closed.

**Real, never faked.** Every value transfer on Hedera (payment, bond, slash). Every ENS
read and write against Sepolia. Every Graph query, against real mainnet data. The
verifier's comparison logic. The MCP server and the Claude agent that drives it and
genuinely decides whether to pay.

**Staged, and said so on screen when it runs.** The "lying provider" is a deliberately
tampered test harness (`createLyingRugScoreProvider`) that runs the real capability and
alters exactly one claim before returning it; it is not a separate, less-real code path.
The watchdog's timing in the demo is scripted (it is told which job and claim to look
at, where a real watchdog would decide that on its own); the challenge, the verifier, the
slash, and the ENS write it triggers are the same real code a spontaneous challenge would
run.

**Honest gaps, not yet closed.**
- A failed challenge is supposed to cost the challenger a deposit too (the design calls
  for both sides having skin in the game); there is no escrow to forfeit yet, so only the
  provider's side of that incentive exists.
- Settlement is not atomic across the three networks, and the code does not pretend it
  is: a job's status is recorded before the ENS write happens, so a write that fails
  midway leaves a truthful status and a named error rather than a silently inconsistent
  one.
- The demo runs one provider and one capability. The seam that lets a second capability
  or a second provider plug in without touching `payments` or `registry` exists, but only
  one instance of each has actually been exercised end to end.
- Only one funded Hedera testnet account exists so far, so every pay/bond/slash
  transaction to date has been a self-transfer (operator to itself); see the Hedera
  track write-up above for what that does and does not prove.
- The payment gate today checks one thing: whether the given transaction id resolved to
  `SUCCESS` on the mirror node. It does not compare the confirmed transfer's amount,
  recipient, or memo against the request being served. The memo does carry the request
  hash, for a human (or a judge) to audit on HashScan, but nothing in the serving path
  reads it back and compares it. Binding that comparison in code, not just leaving it
  checkable by eye, is the next hardening step.

## 7. Demo video script

Based on the measured numbers in `docs/demo-run-sheet.md`, not on the original 90-second
plan in the design doc, which does not reliably fit. Full rehearsals of the live portion
(agent run plus watchdog run, back to back) have measured between 69.4 and 94.6 seconds
of machine time, with no narration and no transitions added. **Do not promise 90
seconds.** Budget close to two minutes for the recorded clip once narration and
transitions are in.

The run sheet's own decision, which this script follows: start the agent during the
introduction instead of waiting on it, and put the closing narration over the ENS write
instead of trying to fill it with more content.

**Before recording:** run `reset-demo-state.ts` (about 57 seconds, resets both the
demo's main provider and its sacrificial one, four ENS writes total) so reputation
starts from a known point. Do not run it on camera.

- **0:00–0:15 — Cold open.** State the problem in one breath: agents will pay other
  agents for services, and there is no portable way to know if the other agent is
  honest before you pay it. Start the requester agent's live run right now, in the
  background; its reasoning streams to screen from this point on.
- **0:15–0:50 — Talk over the agent, don't wait for it.** While the agent's real
  output streams (discovering `rugscore.assay.eth`, reading its manifest and
  reputation, reasoning about whether the price is worth it), narrate what Assay is:
  ENS as the business card, Hedera as the payment rail, The Graph as the thing claims
  get checked against. The agent's own run takes 42 to 57 seconds; it should finish
  mid-explanation, landing on `PAID`.
- **0:50–0:55 — Cut to the "lying provider."** Say plainly that this is a deliberately
  tampered test harness, not a second real provider, and that everything downstream of
  it (challenge, verify, slash, ENS write) is real code, not staged.
- **0:55–1:15 — Challenge, and the reveal.** Trigger the watchdog's challenge. The
  reveal is the verifier's verdict, not the slash: two numbers side by side, at the same
  block, the provider's claimed liquidity against what The Graph actually says. That
  lands in under a second once the query returns; hold on it.
- **1:15–1:16 — Slash.** It lands in about 0.4 seconds. Show the HashScan link
  immediately after, so it reads as a consequence, not a separate wait.
- **1:16–1:40 — Closing narration, over the ENS write.** The write itself takes 8.3 to
  24.6 seconds; treat that spread as a feature of the script, not a risk, and use the
  full range for the closing line: reputation here is not a star rating, it is stake,
  and what is on screen is a public record being updated in front of the audience.
  Nothing scripted needs to happen after this, because if the write hits its slow end
  anything queued behind it will overrun.
- **Fallback.** Record this after a rehearsal that went well, and keep the clip ready.
  Conference wifi affects every step here; the ENS write drifting to its slow end is
  survivable live with narration, a dead network is not.

## 8. Business model, network impact, and what's next

Full versions in the repo; this is the summary for a form field.

**Who pays and for what.** Two revenue lines, both denominated in flows that already
exist: a small protocol fee on each settled call, and a minority share of slashed bonds
(the majority goes to the challenger, because that is what pays for watchdogs to exist).
Listing and reputation reads stay free, because a track record you have to pay to read is
one most buyers skip.

The unusual thing about the cost structure is that **verification is the cost structure**,
and it is variable per challenge rather than per call. That makes the choice of capability
an economic decision, not a demo one: rug-pull scoring is expensive to compute and cheap
to spot-check, so the verifier costs a fraction of the service it polices. A capability
where checking costs as much as doing has no margin and I would not add one. The other
real cost is ENS writes: free on Sepolia, but at mainnet gas a `setText` per job does not
survive a sub-cent call, and the fix (batched epoch writes, or CCIP-read so the record
lives offchain and is proved on read) is Phase 1 work rather than an unknown.

Why it cannot be Web2, in one line each: the bond has to be seizable by rule rather than
by a company, the reputation has to outlive the platform because it lives under the
provider's own ENS name, the counterparties are agents that meet exactly once, and the
audit trail must not be ours to edit. See [`docs/business-model.md`](business-model.md)
for the full Lean Canvas, including what I do not know yet.

**Impact on Hedera, measured rather than projected.** Per job: a paid call with no
challenge is 1 transfer plus 3 consensus messages, four transactions; a challenged and
slashed one is 2 transfers plus 6 messages, eight. Provider onboarding is one account and
one bond transfer each, so account growth is linear in supply. The anchoring is what makes
the multiplier 4 to 8 rather than 1, and it scales with loop events rather than with value
moved, so it holds identically at any price point.

Being straight about the size: 100 providers serving 100 calls a day is roughly 40,000
transactions a day, about 0.46 TPS. That is real traffic and it is not a large number, and
I am not going to extrapolate a headline figure from a hackathon. The argument worth making
is the shape, plus the distribution surface: this ships as an MCP server, so a Claude Code
user adds one config line and then watches real Hedera transaction ids scroll past in their
own terminal, which is exposure to an audience not otherwise looking at Hedera.

**Next.** [`docs/roadmap.md`](roadmap.md) has the order and the reasoning. Phase 1 is
entirely about closing gaps already disclosed above: the challenger deposit first (the
incentive model is only sound with both sides bonded), then affordable reputation writes,
then a second capability written by someone who is not me, which is the only real test of
whether the port boundary generalizes.

**Validation, honestly.** Two feedback cycles are running and neither is a survey.
`FEEDBACK.md` is a report to all three sponsors written from things that cost me time
during the build, with the measurement or error message behind each item; two of them
changed this build. The second is the agent itself: the demo prompt never names the
provider to distrust, so each run tests whether the interface is legible to the only kind
of user this has, and it already returned a finding I would not have got by inspection
(it declined a provider because a 1.00x bond makes lying break-even). What there is not:
external users, trials, or revenue. Ten provider interviews are the next cycle and they
have not happened.

# Business model

Written as a Lean Canvas, plus the two questions the canvas format does not
force you to answer honestly: why this needs Web3 at all, and what I do not
know yet.

Everything here is my own reasoning from building the thing. Where a number is
a guess I say so, because a canvas full of confident invented figures is worth
less than an empty one.

## Lean Canvas

### Problem

Agents are starting to pay other agents for work (x402, MCP tool marketplaces,
the various agent-commerce protocols). Three pieces are missing and the third
is the one nobody has solved:

1. Discovery. Given a task, which agent offers it, at what price?
2. Payment. A rail cheap and fast enough for a sub-cent call.
3. Trust before payment. Is this stranger competent and honest?

Discovery and payment have credible answers already. Trust does not. What
exists is star ratings and review counts, which are subjective, gameable, not
portable between platforms, and evaluated by humans who cannot check the work.
An agent picking a provider has no way to ask "has this one ever been caught
lying" and get an answer it can verify itself.

The existing alternatives, and why they fall short:

- Platform reputation (an app store, a tool registry). Portable nowhere, owned
  by the platform, and the platform's incentive is listing volume.
- Star ratings. Measure whether the buyer was pleased, not whether the answer
  was right. For a rug-pull score the buyer usually cannot tell the difference.
- Staking without verification. Punishes non-delivery, not wrong delivery. A
  provider that always answers and is often wrong keeps its stake.
- Human audits. Do not scale to per-call decisions at sub-second latency.

### Customer segments

Two sides, and they do not adopt for the same reason.

**Provider agents** (the paying side, and the beachhead). Someone who has built
a capability worth money and cannot charge for it, because a buyer meeting them
cold has no reason to believe them. Reputation is what lets them price above
zero. Early adopters look like onchain-analytics shops, risk scorers, data
enrichment services: they already sell into crypto, they already have an API,
and their output is factual enough to verify.

**Requester agents** (the volume side). Orchestrators that need to buy work
mid-task: Claude Code and other MCP clients, LangChain and crewAI pipelines,
autonomous trading and research agents. They adopt because it is one MCP server
away, not because they care about the reputation layer as such.

**Watchdogs** (the third side that makes it work). Anyone who can run a
verifier and earn from catching a lie. Not a customer, an incentive.

### Unique value proposition

Reputation you can audit instead of trust. A provider's track record is not an
average of opinions, it is a count of times an objective verifier re-derived
its claims and agreed. Bad answers cost the provider money, automatically.

The one-line version I would put on a landing page: **your agent should not have
to take a stranger's word for it, and now it does not have to.**

### Solution

- Identity and track record as ENS text records, so both are portable and
  belong to the provider rather than to us.
- A bond posted before serving, so lying has a price.
- Claims that are block-stamped, so they can be re-derived at exactly the state
  they were computed from.
- A verifier that re-derives a challenged claim from an independent source (The
  Graph) and slashes the bond if it disagrees.
- Payment per call on Hedera, because settlement has to be cheaper and faster
  than the work being bought.

### Channels

1. **The MCP server.** This is the distribution. Any MCP client can add Assay
   in one config line and immediately discover, pay and challenge. No SDK to
   adopt, no framework to migrate to.
2. **The ENS namespace.** A provider's name is its business card. `*.assay.eth`
   resolving to a manifest is itself a directory, and it works in any tool that
   already resolves ENS.
3. **Agent framework integrations.** After MCP, the LangChain and crewAI tool
   wrappers are thin.
4. **Verifier authors.** Each new capability verifier brings its own vertical's
   providers with it.

### Revenue streams

Two, both denominated in the flows that already exist:

1. **A protocol fee on settled calls.** A small percentage of each payment,
   taken on Hedera at settlement. It scales with volume rather than with seats,
   and a provider only pays it on money it actually earned.
2. **A share of slashed bonds.** When a challenge is upheld, the bond is
   forfeited. Most of it should go to the challenger, because that is what pays
   for watchdogs to exist at all; a minority share to the protocol.

I deliberately do not plan to charge for listing or for reputation reads. Both
need to be free for the reputation to be worth anything: a track record you
have to pay to read is a track record most buyers will skip.

A third line exists later, once there are enough verifiers to matter: charging
enterprises to run a private instance of the rail over their internal agents,
where the interesting part is the audit trail rather than the payments.

### Cost structure

The unusual thing about this business is that **verification is the cost
structure**, and it is variable per challenge rather than per call.

- **Verification (The Graph).** A challenge means re-running the capability's
  data queries. This is the dominant marginal cost and the reason the choice of
  capability is an economic decision, not just a demo choice: rug-pull scoring
  is expensive to compute and cheap to spot-check, so a verifier costs a
  fraction of the service it polices. A capability where checking costs as much
  as doing has no viable margin, and I would not add one.
- **Reputation writes (ENS).** On Sepolia this is free in practice. On mainnet
  it is the largest fixed cost per outcome, and at current gas a write per job
  does not survive contact with a sub-cent call. The fix is known and not
  exotic: batch reputation updates, or serve the records through a CCIP-read
  wildcard resolver so the record lives offchain and is proved on read. That
  turns a per-job gas cost into a per-epoch one.
- **Payments and anchoring (Hedera).** Effectively noise. A transfer and a
  consensus message together cost small fractions of a cent, which is why this
  rail and not an L1.
- **Infrastructure.** A node, an indexer, nothing remarkable.

### Key metrics

The ones I would actually watch, in the order they matter:

1. **Challenges per 1,000 jobs, and the share upheld.** This is the health of
   the whole idea. Zero challenges means nobody is checking and the reputation
   is decorative. All challenges upheld means providers are not deterred.
2. **Paid calls per week**, and repeat rate per requester.
3. **Bond-to-price ratio across providers.** Below roughly 2x, lying is close
   to break-even and the deterrent is theatre. The demo agent worked this out
   on its own and declined a provider over it, which is the strongest evidence
   I have that the number is legible.
4. Providers with a non-empty track record, which is the supply-side funnel.
5. Time from discovery to first payment, which is the friction number.

### Unfair advantage

Not the code, which is a weekend for a competent team. The moat is the
**verifier corpus**: every capability needs someone to write an objective
re-derivation for it, each one is domain work, and each one makes the rail
useful to a vertical that could not use it before. The second advantage is
compounding and not copyable: reputation earned under a provider's own ENS name
is history a competing rail cannot import, because it is attested by slashes
that happened here.

## Why this cannot be a Web2 product

The honest test is not "could you build the UI in Web2" (obviously yes), it is
"does removing the chain remove the property that makes it work".

- **The bond has to be seizable by rule, not by a company.** A Web2 escrow is
  someone's terms of service. The whole claim is that punishment is automatic
  and does not depend on trusting the operator, including us.
- **The reputation has to outlive the platform.** As ENS records under the
  provider's own name it is theirs; if Assay disappears, their track record does
  not. That is exactly what a Web2 registry cannot offer, and it is why
  providers should be willing to build on it.
- **The counterparties are agents that meet once.** No account, no relationship,
  no recourse. A per-call payment with a public prior is the only shape that
  fits.
- **The audit trail must not be ours to edit.** The loop's own event log is
  hash-chained to a Hedera consensus topic precisely so that our word is not
  load-bearing anywhere in the system.

What genuinely does not need a chain: the discovery index and the verifier
compute. Both are ordinary services, and pretending otherwise would be the
mistake the Feasibility criterion is looking for.

## What I do not know yet

Stated because the gaps are the interesting part:

- **Whether requesters will pay a premium for a verified provider**, or just
  take the cheapest. Reputation only monetizes if it changes the purchase.
- **Whether watchdogs show up.** The economics look right on paper (a
  challenger profits from an upheld challenge), but a failed challenge should
  also cost the challenger a deposit and that half is not built yet. Until it
  is, frivolous challenges are free, which is its own failure mode.
- **The cost of the honest-provider case at scale.** Slashes pay for
  themselves; verifying honest work does not, and the equilibrium I want is one
  where challenges are rare because the deterrent works. That equilibrium
  generates the least revenue from slashes, which is a tension I have not
  resolved.
- **Pricing.** I have no evidence for any specific fee percentage. That is a
  question for the first ten providers, not for a canvas.

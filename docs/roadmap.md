# Roadmap, go to market, and feedback cycles

What happens after the hackathon, who I would ask before building any of it,
and how I would get this in front of the people who could use it.

The order below is deliberate. Everything in the first phase closes a gap I
already know about and stated in the README, because shipping features on top
of a known hole is how a project stops being credible.

## Where it is today

The loop runs end to end on three live networks, in both directions: a lying
provider gets challenged, verified against The Graph, slashed on Hedera and
downgraded on ENS, and an honest provider survives the same challenge with its
bond untouched. A real Claude agent drives it through the MCP server and
decides for itself whether to pay. The event log is hash-chained to a Hedera
consensus topic, so the run's own narration is checkable rather than trusted.

The gaps I know about, restated so the roadmap is read against them: a failed
challenge costs the challenger nothing, settlement is not atomic across the
three networks, there is one capability and one verifier, and reputation writes
would be too expensive on ENS mainnet at current gas.

## Phase 1, the next four weeks

**Make challenging cost something.** A challenger currently risks nothing, so
frivolous challenges are free and a provider can be griefed. The design already
calls for a challenger deposit forfeited on a failed challenge (SPEC section
7); what is missing is the escrow to hold it. This is the single most important
correctness fix, because the incentive model is only sound with both sides
bonded.

**Make reputation writes affordable.** A `setText` per job does not survive
mainnet gas. Two candidate fixes, and I would prototype both before choosing:
batch the updates into an epoch write, or serve the records through a CCIP-read
wildcard resolver so the record lives offchain and is proved on read. The
second is more work and strictly better, because it also removes the 8 to 25
second write latency from the critical path.

**A second capability, from someone who is not me.** One capability with one
verifier proves the mechanism, not the abstraction. The test of whether the
rail generalizes is whether a stranger can add a capability without touching
`packages/core`. If they cannot, the port boundary is wrong and I would rather
find out at capability two than at capability twenty.

**Publish the verifier interface as a document, not just as a type.** Writing a
verifier is the actual work of adopting this, and right now the only
specification of it is source code.

## Phase 2, months two and three

**Verifier SDK and a capability template.** The moat is the verifier corpus, so
the priority is making a third party able to write one in an afternoon: a
scaffold, the tolerance conventions, and a lying-provider harness they can point
at their own capability to prove their verifier catches a tampered claim. That
harness is the part I would emphasise, because it is what turned my own verifier
from an assumption into a tested one.

**Mainnet, once the cost model above is fixed and not before.** Hedera mainnet
for payments, ENS mainnet for identity. Deploying to mainnet with a per-job gas
cost that does not close would be a demo dressed as a launch.

**Settlement that degrades honestly.** Three networks and no bridge means a
partial failure is possible by construction. Today the job status is recorded
before the ENS write, so a failed write leaves a truthful status and a named
error. That is correct but minimal; the next step is a reconciler that retries
the outstanding half and a public way to see what is outstanding.

## Go to market

**Beachhead: onchain analytics providers.** Not because the market is large,
but because it is the one segment where a verifier already exists. Their output
is factual, block-pinned, and re-derivable from The Graph, which means I can
write the verifier for them rather than asking them to. Risk scoring, wallet
labelling, liquidity and holder analysis: all of it is expensive to compute and
cheap to spot-check, which is the economic shape the whole model needs.

**Wedge: the MCP server, not an SDK.** Adoption cost for the buying side has to
be one line in a config file. Anyone already running Claude Code, or any other
MCP client, can discover and pay a provider without adopting a framework. The
selling side is a heavier lift by nature (post a bond, publish a manifest,
accept being verifiable), which is why providers are the ones I would talk to
by hand and buyers are the ones I would reach through distribution.

**Sequence.** Ten providers by hand first, each one onboarded personally and
each one a source of feedback on the manifest format and the bond sizing. Only
then the buying side, because a marketplace with nothing verified on it teaches
a buyer that verification does not matter. The failure mode I want to avoid is
launching the demand side into an empty directory.

**Positioning against the obvious comparison.** The nearest thing conceptually
is an optimistic oracle, and I should say so rather than pretend novelty:
bond, challenge window, dispute resolution. The difference worth leading with
is that the resolution here is mechanical rather than a vote. There is no
token-holder quorum deciding who was right, just a re-derivation from a source
both sides already agreed to at a block both sides already agreed to. That is a
narrower claim than a general oracle makes, and it is narrower on purpose: it
only works for capabilities whose output is checkable, and those are exactly the
ones worth starting with.

## Feedback cycles

Four, in the order I would run them. Two of them already exist.

**1. Sponsor tooling feedback, running now.** `FEEDBACK.md` is a full report
written from things that actually cost me time during the build: an SDK footgun
in `PrivateKey.fromString` that nearly ended the project, a block-filtering
limitation in The Graph's Token API that made me switch to the gateway, and
ENS write latency measured across seven real confirmations. Every item carries
the measurement or the error message that established it. This is a real cycle
because the recipients ship the tools and can act on it, and because it already
changed my own build twice.

**2. The agent as a user, running now.** The demo prompt sets a goal and a
budget and never names which provider to distrust or when to challenge. That
makes each run an observation of whether the interface is legible to the buyer
it is designed for. It has already produced a finding I would not have reached
by inspection: the agent declined a provider because the bond was only 1.00x
the price, reasoning that lying is therefore break-even and the deterrent is
absent. That is user feedback on the bond-sizing parameter, from the only kind
of user this thing has.

**3. Ten provider interviews, next.** The people I would ask are the analytics
shops in the beachhead above. Three specific questions: would you post a bond
to be discoverable, what bond multiple feels like a real deterrent rather than
a tax, and would you accept a verifier written by someone else deciding whether
you were wrong. The third question is the one that decides whether this is a
product, and I do not know the answer.

**4. A public challenge log as a standing cycle.** Once there is volume, every
upheld and failed challenge is a data point on whether the tolerances are right.
Too many upheld challenges on honest providers means the verifier is too strict
and the rail punishes people for data drift; none at all means nobody is
checking. Publishing that ratio is both the metric and the feedback loop, and it
is the number I would want a prospective provider to be able to read before
deciding to trust the system with its money.

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

- **The Graph** (Token API, mainnet, read-only): the source of truth for scores and
  verification.
- **Hedera** (testnet): pay, bond, slash.
- **ENS** (Sepolia): identity manifest and portable reputation in text records.

## Prize tracks (ETHGlobal Lisbon 2026)

- **Hedera**: AI & Agentic Payments
- **The Graph**: Best AI Use Case
- **ENS**: Best Integration for AI Agents

## Repo layout

```
packages/   core, registry (ENS), payments (Hedera), graph (Token API), cap-rugscore
apps/       mcp (server), provider, watchdog, dashboard
```

## Status

Work in progress, built over a 36 hour hackathon. The detailed design doc is kept
private; this README is the public overview.

## License

MIT. See [LICENSE](LICENSE).

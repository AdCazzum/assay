@AGENTS.md

## Claude Code specific

Everything about *how this repo is built* (layout, runtimes, networks, the hard
rules) lives in `AGENTS.md`, imported above. This section is only for how **Claude
Code** should operate here.

### Read the design first

`SPEC.md` (local, untracked) is the source of truth for the design: architecture,
the generic capability/verifier seam, the loop, the 36h plan, and **what is real vs
mocked**. Read it before writing code. Do not re-derive the design.

### Skills to use

- **superpowers:test-driven-development** — for `packages/cap-rugscore`, especially
  `verify()`. The verifier is the crux and the demo climax; write the lying-provider
  test first.
- **superpowers:systematic-debugging** — when an SDK integration misbehaves (Hedera
  and ENS testnet plumbing will, and every real bug in this repo so far has looked
  like something other than what it was).

This used to mandate **mcp-builder** for `apps/mcp`. That skill is not installed on
this machine, so the server was built from the SDK's own type definitions instead and
the rule pointed at nothing. Install it or leave it out; do not reinstate a rule
nobody can follow.

### Hard rules

- **Verify against the live network, not only against fakes.** This is the rule this
  repo learned the hard way, three times. The payment gate, the loop-event sink and
  the default provider list each shipped with every unit test green and broke on first
  real contact, because the fakes model the configured happy path rather than what the
  chain and the tooling actually do. If a change touches Hedera, ENS or The Graph, run
  it for real before you believe it.
- **The demo is a real Claude Code session**, not an app in this repo. Two custom
  runners were built and deleted. If you are tempted to build a third, read
  `docs/demo-run-sheet.md`'s closing section first.
- **Never commit secrets or `SPEC.md`.** Both are gitignored; keep them that way.
- **Real vs mocked** is defined in `SPEC.md` §11. Never mock the actual sponsor
  integration a bounty scores (a faked ENS write, a hand-rolled paywall dressed up
  as x402, an RPC read narrated as a subgraph query). Label test harnesses (the
  lying provider) honestly.
- **Demo-first.** This is 36h; protect the live end-to-end path over feature depth.

### Context discipline

Read `SPEC.md` plus the one package you are working in. You do not need to hold the
whole monorepo in context at once; the packages have clean boundaries by design.

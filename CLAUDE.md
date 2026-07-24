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

- **mcp-builder** — for `apps/mcp` (the MCP server exposing discover / pay_and_call /
  challenge / rate). This is the agent-native surface a real Claude agent drives in
  the demo.
- **superpowers:test-driven-development** — for `packages/cap-rugscore`, especially
  `verify()`. The verifier is the crux and the demo climax; write the lying-provider
  test first.
- **superpowers:systematic-debugging** — when an SDK integration misbehaves (Hedera
  and ENS testnet plumbing will).

### Hard rules

- **Spike the Hedera rail in the first ~2 hours** before building the loop on it.
  Raw HBAR transfer is the safe fallback. (See AGENTS.md.)
- **Never commit secrets or `SPEC.md`.** Both are gitignored; keep them that way.
- **Real vs mocked** is defined in `SPEC.md` §11. Never mock the actual sponsor
  integration a bounty scores (a faked ENS write, a hand-rolled paywall dressed up
  as x402, an RPC read narrated as a subgraph query). Label test harnesses (the
  lying provider) honestly.
- **Demo-first.** This is 36h; protect the live end-to-end path over feature depth.

### Context discipline

Read `SPEC.md` plus the one package you are working in. You do not need to hold the
whole monorepo in context at once; the packages have clean boundaries by design.

# AGENTS.md

Build conventions for Assay, for AI coding agents (Claude Code, Codex, Cursor, …)
and humans. This file is the source of truth for how the repo is built; tool
specific files (e.g. `CLAUDE.md`) point here.

## What this is

Assay is a reputation and payment rail for agent-to-agent services (see
`README.md` for the pitch). The full design lives in **`SPEC.md`**, which is kept
**local and untracked** (it is gitignored on purpose). Read `SPEC.md` before making
design decisions; it is the source of truth for the architecture, the loop, and
what is real vs mocked.

Context: this is a **36 hour ETHGlobal Lisbon 2026 hackathon build**, solo. Optimize
for a **demoable end-to-end path**, not for completeness. When in doubt, cut scope to
protect the live demo.

## Repo layout

pnpm monorepo, TypeScript, ESM.

```
packages/
  core         orchestrates the loop; knows nothing about rug-score
  registry     ENS adapter (Sepolia): manifest + reputation text records
  payments     Hedera adapter (testnet): pay / bond / slash / confirm
  graph        The Graph Token API adapter (mainnet, read-only)
  cap-rugscore the one concrete capability: run() + verify()
apps/
  mcp          MCP server exposing discover / pay_and_call / challenge / rate
  provider     long-running agent that serves rug-score requests
  watchdog     challenges a claim (the demo climax)
  dashboard    narrates the loop on screen
```

## Runtimes

- Node >= 22 (via mise), pnpm workspaces.
- `mise` is not loaded in non-interactive shells: in scripted/tmux contexts run
  `eval "$(~/.local/bin/mise activate bash)"` first, or `pnpm`/`node` are not found.

## Networks & secrets

Three independent networks (no bridge). Provide credentials via a local `.env`
(never commit; `.env` is gitignored, keep a `.env.example` with keys only):

- Hedera testnet operator id + key (pay / bond / slash).
- Sepolia wallet private key that owns the ENS parent name (manifest + reputation
  writes). The parent lives on **Sepolia** (mainnet `assay.eth` is taken by a third
  party and is not needed for the build).
- The Graph API key (Token API, mainnet, read-only).

## The one hard rule: spike before you build

The **Hedera payment rail is the highest risk**. In the first ~2 hours, prove one
clean round trip (pay -> mirror-node confirm -> unlock) with the sponsor tooling
(x402 / Agent Kit / OpenClaw ACP). If it does not integrate cleanly in time, fall
back to a **raw HBAR transfer + mirror-node poll** (it still qualifies for the
bounty) and disclose it honestly. Do not build the whole loop on an unproven rail.

## Testing

The **verifier is the crux**. Unit-test `cap-rugscore` with two token fixtures (one
clean, one rug) plus a **lying-provider** fixture that tampers one claim; the
verifier must catch it. That test is also the demo climax. Claims are
**block-stamped**: the verifier must query the same block, or honest providers get
slashed on data drift.

## Commits

Conventional Commits. Keep commits **incremental and real** as you build; a single
giant "hackathon submission" commit at the end is a red flag to sponsor judges.
Never commit secrets or `SPEC.md`.

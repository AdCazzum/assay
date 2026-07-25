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
  graph        The Graph adapter: block-pinned Uniswap v3 subgraph queries
  cap-rugscore the one concrete capability: run() + verify()
apps/
  mcp          MCP server, nine tools; what a real Claude Code session drives
  provider     long-running service that serves rug-score requests
  watchdog     challenges a claim from the command line
  dashboard    renders the loop; also the offline fallback (replays fixtures)
```

The MCP server is the product. `apps/provider` and `apps/watchdog` are runnable
demonstrations of the two roles, and `apps/dashboard` is a renderer plus the
no-network fallback. The demo itself is not an app in here: see below.

## Running the demo

Not a script and not an app in this repo. Open **Claude Code** here and run
**`/assay-demo`**: `.mcp.json` registers the `assay` server, so a real session
drives the real loop and renders its own reasoning and tool calls. Confirm with
`claude mcp list`, which should report `assay: ... Connected`.

```bash
./scripts/demo.sh          # reset both providers first (~57s). Never on stage.
bash -lc 'claude'          # then /assay-demo
```

Two earlier attempts (a keypress runner, then a custom terminal UI) were deleted.
The reason worth keeping: **a renderer we write is less credible than the tool the
audience already uses.** A judge cannot verify that our screen showed them the
truth; in Claude Code they see the MCP badge, the real tool names, the arguments
and the raw JSON.

The prompt lives in `.claude/commands/assay-demo.md`. It sets a goal and a budget
and **never names the provider to distrust, the claim to check, or when to
challenge**. Keep it that way: a prompt that scripts the decision turns the demo
into a performance, which SPEC §16 names as the failure to avoid.

`pnpm --filter @assay/dashboard exec tsx src/index.ts slash` replays a captured
run with no network at all, which is the fallback when the wifi dies.

## Runtimes

- Node >= 22 (via mise), pnpm workspaces.
- `mise` is not loaded in non-interactive shells: in scripted/tmux contexts run
  `eval "$(~/.local/bin/mise activate bash)"` first, or `pnpm`/`node` are not found.
- **The two halves trap.** A live agent run needs `CLAUDE_CODE_OAUTH_TOKEN`, which
  is exported *above* the interactive guard in `~/.bashrc`, so a login shell has
  it. `mise` is activated *below* that guard, so a login shell does **not** have
  it. Plain `bash -lc 'pnpm ...'` therefore fails with `pnpm: command not found`,
  and plain `pnpm ...` from a script fails with `Not logged in`. You need both:
  `bash -lc 'eval "$(~/.local/bin/mise activate bash)"; pnpm ...'`.

## Build tooling

TypeScript ESM, `moduleResolution: "Bundler"`, run straight from source.

- **No emit step.** Nothing here is published; every app runs under `tsx` and
  tests run under `vitest`, both of which read `.ts` directly. So each package's
  `build` script is `tsc --noEmit`: it is a typecheck, named `build` because
  that is the workspace-wide verb. There is no `dist/`, and therefore no build
  ordering and no stale-output class of bug.
- **Packages resolve to source.** Each `package.json` has
  `"exports": { ".": "./src/index.ts" }`, so `@assay/core` imports resolve to
  the live source across the workspace with no watch step.
- **Relative imports carry the `.js` extension** (`./types.js` → `types.ts`).
  Both tsc and vite resolve it; keep it consistent.
- **Dependencies are installed up front** (ethers, `@hashgraph/sdk`,
  `@modelcontextprotocol/sdk`, vitest, tsx). Adding a dependency rewrites
  `pnpm-lock.yaml`, which is the one file every parallel agent would collide on,
  so **do not add packages unless the issue genuinely needs one** — and say so
  in the PR when you do.
- Commands: `pnpm -r typecheck`, `pnpm -r test`, or scoped to one package with
  `pnpm --filter @assay/<pkg> test`. Prefer the scoped form while working.

The shared contracts live in `packages/core/src/`: `types.ts` (`Claim`,
`Capability`, `Manifest`, `Reputation`, `Job`) and `ports.ts` (`RegistryPort`,
`PaymentsPort`, `GraphPort`). Adapters implement those interfaces; that is what
lets the packages be built independently and in parallel.

## Networks & secrets

Three independent networks (no bridge). Provide credentials via a local `.env`
(never commit; `.env` is gitignored, keep a `.env.example` with keys only):

- Hedera testnet operator id + key (pay / bond / slash). The portal issues
  **ECDSA** accounts, so parse with `parseOperatorKey`, never
  `PrivateKey.fromString`, which silently reads a bare hex key as ED25519 and
  hands back a valid key that is not yours. You find out at the network, as
  `INVALID_SIGNATURE`.
- A **second** Hedera account as payee/bond/challenger, so transfers are real
  rather than self-transfers. This matters twice over: nothing of value moves in a
  self-transfer, and the mirror node reports one as only the fee movement, so the
  amount check in `confirmPayment` can never pass on it. Create with
  `packages/payments/scripts/create-account.ts`, which keeps the key; recycle its
  balance with `sweep-payee.ts`, since everything otherwise flows one way and the
  operator drains at roughly 90 HBAR per rehearsal cycle.
- Sepolia wallet private key that owns the ENS parent name (manifest + reputation
  writes). The parent lives on **Sepolia** (mainnet `assay.eth` is taken by a third
  party and is not needed for the build). Subnames resolve through a **wildcard
  resolver**, so any label under the parent is writable with no on-chain creation
  step. Do not trust the `.eth` BaseRegistrar here: it reports the name expired
  while resolution works fine.
- The Graph API key (Studio), used against `gateway.thegraph.com` for block-pinned
  subgraph queries. Note the Token API is a different product on a different host
  and wants a different credential: see `FEEDBACK.md`.

## The one hard rule: spike before you build

The **Hedera payment rail is the highest risk**. In the first ~2 hours, prove one
clean round trip (pay -> mirror-node confirm -> unlock) with the sponsor tooling
(x402 / Agent Kit / OpenClaw ACP). If it does not integrate cleanly in time, fall
back to a **raw HBAR transfer + mirror-node poll** (it still qualifies for the
bounty) and disclose it honestly. Do not build the whole loop on an unproven rail.

## Testing

The **verifier is the crux**. `cap-rugscore` is unit-tested with two token fixtures
(one clean, one rug) plus the **lying-provider** harness that tampers one claim;
the verifier catches it. That test is also the demo climax. Claims are
**block-stamped**: the verifier queries the same block, or honest providers get
slashed on data drift.

`TESTING.md` is the full walkthrough, ordered so a failure tells you which of the
three networks to blame.

**The lesson this repo keeps re-learning: unit tests pass on things the chain does
not do.** The payment gate, the event sink and the default provider list each shipped
green and broke on first real contact, because the fakes model the configured happy
path rather than the network's actual behaviour. Anything touching a live network
needs a live run before you believe it.

## Commits

Conventional Commits. Keep commits **incremental and real** as you build; a single
giant "hackathon submission" commit at the end is a red flag to sponsor judges.
Never commit secrets or `SPEC.md`.

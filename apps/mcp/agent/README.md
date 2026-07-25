# Wiring a live Claude agent to the Assay loop (issue #24)

**Since issues #93/#94:** `prompt.md` now carries the fuller mission (`list_providers`,
`verify_claim`, `challenge`, `rate`, not just `discover`/`pay_and_call`) and `ALLOWED_TOOLS`
below was widened to match. The demo that shows this live is a real Claude Code session running `/assay-demo`.mcp.json`), documented in
`docs/demo-run-sheet.md`. This directory's own `run-agent.ts`/three targets still work exactly
as described below (they predate the Claude Code path and are independent of it) and remain useful for capturing a raw transcript
without the two-column display.

This directory is the "agent-native" half of the demo: a real Claude Code agent
(not a script, not an `if`) drives the Assay MCP server (`discover` /
`pay_and_call` / `challenge` / `rate` / `verify_claim` / `list_providers` /
`get_job` / `list_jobs`), reads a provider's reputation, and decides for itself whether the
price is worth the risk.

## Files

- **`prompt.md`** — the exact, verbatim prompt handed to the agent. This is
  part of the submission: read it to see the agent was given a goal and
  constraints ("decide for yourself whether the reputation justifies the
  price"), never an instruction to pay or decline. All three demo runs below
  use this same file, unedited.
- **`mcp-config.live.json`** / **`mcp-config.good-provider-demo.json`** /
  **`mcp-config.bad-provider-demo.json`** — templates showing the MCP server
  registration shape for a Claude client (`claude_desktop_config.json`-style
  `mcpServers` block), for a human wiring this server into their own Claude
  Desktop or Claude Code project config. `scripts/run-agent.ts` does not read
  these directly; it regenerates the same shape with self-resolved absolute
  paths so the script works from whatever checkout it is run from (see the
  script's doc comment).
- **`transcripts/`** — real transcripts from actual runs (see below), both
  the raw `stream-json` NDJSON from `claude` and a readable `.md` rendering.

## Running it

From the repo root, with `.env` populated (see `AGENTS.md`):

```sh
pnpm --filter @assay/mcp agent:live            # real ENS + Hedera + Graph
pnpm --filter @assay/mcp agent:good-provider   # fixture registry, real Hedera + Graph
pnpm --filter @assay/mcp agent:bad-provider    # fixture registry, no live calls at all
```

`agent:live` and `agent:good-provider` need `HEDERA_OPERATOR_ID`,
`HEDERA_OPERATOR_KEY`, `GRAPH_API_KEY`; `agent:live` additionally needs
`SEPOLIA_RPC_URL`, `SEPOLIA_PRIVATE_KEY`, `ENS_PARENT_NAME` (its registry read
is live ENS, unlike the other two). `agent:bad-provider` needs no live
credentials at all.

All three invoke `claude -p` headlessly (`--mcp-config`, `--strict-mcp-config`,
`--allowedTools` scoped to the four `assay` tools, `--permission-mode
bypassPermissions` since nothing else needs approval in a scripted run,
`--output-format stream-json` to capture the full transcript including tool
calls, `--max-budget-usd` as a spend cap on the Claude API side). See
`scripts/run-agent.ts` for the exact invocation.

## Why there are three runs, and what is real in each

SPEC.md §16 risk 5 calls out "agentic must be real reasoning, not a hardcoded
`if`" as a headline risk. The way to prove that is to give the agent the
*same* prompt against a good provider and a bad one and show it decide
differently, with no branch anywhere in this repo's code picking the outcome.

- **`agent:live`** talks to the real `AssayNodePort`
  (`src/index.ts`'s `buildLiveNodeFromEnv`): `discover("rugscore.assay.eth")`
  is a real Sepolia ENS read of the live manifest and reputation, and if the
  agent decides to pay, `pay_and_call` is a real Hedera testnet payment, a
  real mirror-node confirmation, and a real Graph Token API query. This is
  the fully-real end-to-end path.

  **Disclosed finding from the actual run on file in `transcripts/`:** the
  live record's reputation at run time was `{"score":86,"jobs":2,"slashes":0,
  "bondHbar":0.02}` against a 5 HBAR price — a bond only 0.4% of the price.
  The agent read that correctly and declined, reasoning that collateral this
  thin makes `challenge` a hollow safety net. That is a genuinely low bond on
  the real, shared record (most likely moved there by another live write
  against the same testnet name while this repo was being built in parallel
  across several worktrees; see `AGENTS.md`'s note on shared live state), not
  a bug in this app. It means the live leg currently demonstrates the decline
  side of the contrast, live and for real, rather than the pay side.

- **`agent:good-provider`** is a hybrid, added specifically because the live
  leg above currently declines: it is not a second live ENS registration
  (there is only one Assay provider registered on Sepolia for this
  capability), but everything past the registry read is real. `payments` is
  `@assay/payments`'s real Hedera testnet adapter, `graph` is
  `@assay/graph`'s real Token API adapter, and the capability is the real,
  unmodified rug-score capability — see `src/demo/good-provider-node.ts`'s
  module doc comment. Only `registry.resolveProvider` is a declared fixture,
  returning a fabricated but well-collateralized `ProviderRecord` (30 jobs, 1
  slash, 50 HBAR bond at 10x price). When the agent decides to pay here, it
  really spends real testnet HBAR and gets a real rug-score result for real
  (see `transcripts/`: a real Hedera tx id, a real block-stamped score for
  USDC straight off The Graph).

- **`agent:bad-provider`** talks to a fully declared fixture server
  (`src/demo/serve-bad-provider.ts` / `src/demo/bad-provider-node.ts`):
  `discover` and `payAndCall` never touch Sepolia, Hedera, or The Graph at
  all. Registering a second, badly-reputed live ENS name needs a brand-new
  subname with its own resolver assigned first, which is
  `packages/registry`'s surface, not this app's, and cannot be done
  headlessly on this box (no browser, no GUI here — see
  `packages/registry/scripts/smoke.ts`'s prerequisite note). Rather than fake
  that ENS read, `bad-provider-node.ts` is honestly declared as a fixture in
  its own doc comment and in every error message it can throw. What *is* real
  in that leg: `assessProvider` and `evaluatePayDecision` are `@assay/core`'s
  actual, unmodified functions run over the fabricated `ProviderRecord`, so
  the reasoning material and the policy floor the agent sees are genuine
  production logic, not narrated text. Only the underlying reputation numbers
  are staged, and staged specifically to be a clear decline (a third of jobs
  slashed, bond no bigger than one call's price), not a hairline case.

All three runs get the identical prompt, the identical `capabilityId`
(`"rugscore.assay.eth"`), and the identical token request
(`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, USDC). The only thing that
differs between them is which process is backing the `assay` MCP server, i.e.
which `ProviderRecord` that name resolves to — exactly the variable a
requester agent would face querying different real counterparties in the
protocol. There is no `if (providerIsGood)` anywhere in this repo: the
`good-provider`/`bad-provider` split is two separate declared fixtures
because there is only one live registration to point at, not a branch the
agent's code takes.

## Honesty

Per `AGENTS.md`: `agent:good-provider` and `agent:bad-provider` are not
presented as live ENS resolutions, only `agent:live` is. If you are reading
this and `transcripts/` is missing a run, or a transcript lacks an explicit
`pay_and_call` (or explicit decline) from the model itself, that means the
live agent run did not complete as described — see the PR for exactly where
it stopped.

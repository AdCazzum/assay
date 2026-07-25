# Demo run sheet

Everything below is measured, not estimated. Supersedes the keypress-runner run sheet that
issues #93/#94 replaced: there is no keyboard driving the loop any more, an autonomous agent
does, so "press [1] discover" is gone and the timings below are from a real, unattended run.


## What the demo is

A **real Claude Code session** in this repo, driving the real loop through the `assay` MCP
server. Not a script, and not a custom terminal app.

## Running it: Claude Code, with the server registered

The demo is a **real Claude Code session** in this repo, not a script and not a custom
terminal app:

```bash
./scripts/demo.sh          # reset both providers first (~57s). Never on stage.
claude                     # then, in the session:
/assay-demo
```

`.mcp.json` registers the `assay` server, so Claude Code discovers it on open. Confirm with
`claude mcp list`, which should show `assay: ... Connected`.

`.claude/commands/assay-demo.md` holds the prompt. It sets a goal and a budget and **never
names the provider to distrust, the claim to check, or when to challenge**. That is the whole
point: what the audience watches is the model deciding, and a prompt that scripted the decision
would make the demo a performance. SPEC section 16 is explicit about this being the failure to
avoid.

### Why this rather than a custom screen

An earlier attempt rendered the agent's stream and the loop's events into a purpose-built
terminal UI. It was deleted, for two reasons that are worth remembering.

It was hard to read, which is a fixable problem. But the real one is that **a renderer we wrote
is less credible than the tool the audience already uses.** A judge has no way to know whether
our compositor is showing them the truth. In Claude Code they see the MCP server badge, the
real tool names, the arguments, and the raw JSON that came back. Nothing about it has to be
taken on trust.

It also makes the demo genuinely interactive in the way that matters: a judge can ask for a
different token, or ask the agent why it decided something, and watch it answer.

### What is lost, and how it is covered

**Pacing control.** Claude Code decides its own path and may take longer or shorter than the
115s a scripted run took. Do not promise a duration.

**The offline fallback.** There is no rehearsal mode any more. The recorded clip (#31) is the
only thing that survives dead wifi, so record it after a rehearsal that went well.


## The mission prompt

`.claude/commands/assay-demo.md`. It sets a goal and a budget and deliberately **never names
the provider to distrust, the claim to check, or when to challenge**. Two providers exist on
chain, one clean and one carrying slashes, and `verify_claim` lets the agent check a claim
before disputing it, so the arc comes out of the agent's own incentives.

If a run does not reach the challenge, that is information about the design. Do not add a hint
until it does: SPEC section 16 names a scripted decision dressed as agency as the failure this
whole project has to avoid.

## The on-chain audit trail

`.mcp.json` sets `ASSAY_LOOP_EVENTS_SINK=.assay/loop-events.ndjson`, so the MCP server appends
one NDJSON line per loop event as it runs: transaction ids, block numbers, claim values,
reputation before and after. It never touches stdout, which is the MCP protocol channel, and a
failing sink cannot break a tool call.

It is not a display feed, it is evidence. After a run, that file is what lets anyone reconcile
what the agent said against what actually happened on chain, independently of the transcript.
Gitignored, since it is per-run.

## A real run, measured (2026-07-25)

One full agent run, real Sepolia/Hedera/Graph networks, no fixture anywhere. Measured through
the now-deleted scenic runner, but the agent's behaviour is the MCP server's, not the runner's,
so the numbers still describe what a Claude Code session does. Re-time it on the new path before
relying on the total.

**Total wall clock: 114.3s** (`result.duration_ms`), 19 turns, $0.69 API cost, exit 0.

The agent, entirely on its own:

1. Called `list_providers` and read both `rugscore.assay.eth` (score 78, 14 jobs, 0 slashes) and
   `vantage.assay.eth` (score 88, 9 jobs, 1 slash, 11.1% slash ratio) before touching either.
2. Discovered, assessed, and paid **both** — reasoning explicitly that the higher headline score
   (88) was not automatically the safer bet given the slash on record, and that a second,
   independent read was worth the budget for a decision this size.
3. Verified **all five claims on both jobs**, not just the one that looked suspicious per the
   prompt's own instruction — ten `verify_claim` calls total.
4. On `vantage.assay.eth`'s job, `liquidityUsd` came back **FALSE**: claimed `1,000,056.51` at
   block 25610881, The Graph reporting `56.51334895971466` at that same block (the declared
   `createLyingRugScoreProvider` harness's default tamper: `+max(|honest|*10, 1_000_000)`). Every
   other claim on that same job verified true.
5. **Challenged it, on its own** — `challenge("job-2", "liquidityUsd")` — and explicitly declined
   to spend the remaining budget on a third read, reasoning it already had "a five-for-five
   verified read."
6. `rate`-ed the honest job satisfied (reputation 78→79, jobs 14→15, real ENS tx
   `0x41accfa1...`).
7. Closed with the required `PROVIDERS CONSULTED` / `PAID` / `CHALLENGED` / `VERDICT` lines,
   naming real numbers throughout, recommending against the token.

Phase timing (from the capture's own `recordedAtMs`, relative to run start):

| phase | elapsed | what happened |
|---|---|---|
| 0 – 5.3s | 5.3s | CLI init, first reasoning text, `list_providers` tool call/result |
| 5.3 – 16.1s | 10.8s | reasoning over both providers' signals |
| 16.1 – 20.7s | 4.6s | pay `rugscore.assay.eth`: real Hedera payment, mirror-node confirm in 4.2s |
| 20.7 – 26.8s | 6.1s | serve + accept (real Graph query, block 25610878), reasoning begins |
| 26.8 – 28.8s | 2.0s | five `verify_claim` calls against the honest job, all true |
| 28.8 – 41.9s | 13.1s | reasoning toward `rate` |
| 41.9 – 50.3s | 8.4s | `rate`: real ENS reputation write, 8.5s, heartbeat every ~3s |
| 50.3 – 55.1s | 4.8s | pay `vantage.assay.eth`: real payment, confirm in 4.2s |
| 55.1 – 61.5s | 6.4s | serve + accept (block 25610881) |
| 61.5 – 63.6s | 2.1s | five `verify_claim` calls; `liquidityUsd` FALSE, four others true |
| 63.6 – 74.1s | 10.5s | reasoning toward the decision to challenge |
| 74.1 – 74.5s | 0.4s | `challenge`: verdict re-confirmed, committed |
| 74.5 – 82.8s | 8.3s | settle(): slash + reputation write concurrently (see below); ENS write lands, heartbeat every ~3s |
| 82.8 – 115.0s | 32.2s | closing reasoning (explicitly declines to retry the failed slash or spend more budget), final verdict |

**One real, disclosed limitation this run surfaced, not introduced by this work**: the Hedera
**slash transfer itself failed** with `unknown bondRef`. `packages/payments/src/payments.ts`'s
own doc comment says why: its bond ledger is a small in-memory `Map`, "not durable and does not
survive a process restart" (SPEC.md §17's declared scope cut). `reset-demo-state.ts` posts
`vantage.assay.eth`'s bond in its *own* process, which exits before the agent ever runs; the live
MCP server the agent actually drives is a *third*, separate process, whose own payments port
never saw that `bondRef`. The old keypress runner never hit this because its `doChallenge`
re-bonded the sacrificial provider inside the *same* process immediately before challenging —
the scenic runner's live agent has no equivalent step, and adding one would mean spending a real
bond on every server start regardless of whether the agent ever challenges, which is out of
scope for #93/#94.

**What still landed for real despite that**: `settle()` runs the slash and the ENS reputation
write concurrently and neither depends on the other's outcome (#53) — so even though the slash
failed, the reputation write still landed for real: `vantage.assay.eth`'s ENS reputation dropped
**score 88 → 58, jobs 9 → 10, slashes 1 → 2** (`SETTLEMENT_SCORE_PENALTY` is -30), real tx
`0xd9b46daf...`. The job itself is durably `challenged` with `verdict.valid: false` on record.
The one thing that did not move was the actual HBAR transfer to the challenger — the bond
itself is still sitting wherever `reset-demo-state.ts`'s process left it, unslashed.

**Say this plainly on stage rather than hiding it**: the agent caught the lie and disputed it
entirely on its own reasoning, and the public ENS record collapsed for real. The one asterisk is
infrastructural, not agentic — a real gap in the payments adapter's per-process bond bookkeeping
that a future issue should fix (e.g. resolving bonds through the mirror node by account/amount
rather than an in-memory map, or having `register_provider`/reset tooling and the live server
share a bond ledger). It does not reflect on whether the agent's reasoning was real.



The reputation records are real and every run changes them, so reset first:

```
pnpm --filter @assay/registry exec tsx scripts/reset-demo-state.ts
```

Takes ~35-60s (two providers, two real bonds, four ENS writes) and must end with
`read-back matches target: OK`. Do not run it while presenting.

| | reset to | why |
|---|---|---|
| `rugscore.assay.eth` | score 78, 14 jobs, 0 slashes, bond 6x price, `capabilityId: "rugscore"` | without it the agent correctly declines to pay and the run never gets past discover |
| `vantage.assay.eth` | score 88, 9 jobs, 1 slash, bond 6x price, `capabilityId: "rugscore.v2"` | without the capability-id fix there is no live lie behind this name at all; without the reputation reset the score sits too low to visibly collapse again |

The deleted runner used to check `rugscore.assay.eth`'s live reputation before spawning the
agent and refuse
to start with a clear message if it would make the agent's own pay decision decline.

Checklist:

- [ ] `reset-demo-state.ts` run, `read-back matches target: OK`
- [ ] `CLAUDE_CODE_OAUTH_TOKEN` present in the shell that launches the agent (`~/.bashrc`; a
      non-login/non-interactive shell needs `bash -lc`, and needs `mise`'s node/pnpm on `PATH`
      too since mise's own activation sits behind an interactive guard)
- [ ] Hedera operator balance non-trivial
- [ ] `claude mcp list` shows `assay: ... Connected`, which needs no
      network and confirms the two-column narration renders at the same pace a live run will


## Fallback

The transcripts under `apps/mcp/agent/transcripts/` are
the fallback if conference wifi dies mid-demo: `rehearsal` needs no network at all and reproduces
the exact run above, `REPLAY` declared in the HUD throughout.

Every claim on screen is independently checkable afterwards: HashScan for the Hedera
transactions, Sepolia Etherscan for the ENS writes, and the block numbers against The Graph
directly.


## What this replaced, and why it is worth remembering

Two earlier attempts, both mine, both wrong in instructive ways.

**A keypress runner** (#86) that stepped through the loop on 1/2/3/4. It worked and it was not
a demo: pressing keys to advance a fixed order is launching scripts with an extra step. The
mockup was mine and the goal it was built against was never the one that had been stated.

**A scenic terminal UI** (#94) that composited the agent's stream and the loop's events into one
purpose-built screen. It was unreadable, which was fixable. The reason it was deleted is the
other one: **a renderer we wrote is less credible than the tool the audience already uses.** A
judge cannot verify that our compositor showed them the truth. In Claude Code they see the MCP
badge, the real tool names, the arguments and the raw JSON. Nothing has to be taken on trust.

What survived from both, because it was the actually valuable part: the nine MCP tools, the
loop event stream in core, `verify_claim`, and the NDJSON audit trail.

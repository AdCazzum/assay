# Demo run sheet

Everything below is measured, not estimated. Supersedes the keypress-runner run sheet that
issues #93/#94 replaced: there is no keyboard driving the loop any more, an autonomous agent
does, so "press [1] discover" is gone and the timings below are from a real, unattended run.

## The scenic runner: `apps/demo`

One command, one screen, no keypresses:

```
pnpm --filter @assay/demo exec tsx src/index.ts live                      # real agent, real networks
pnpm --filter @assay/demo exec tsx src/index.ts rehearsal [capturePath]   # offline replay of a captured run
```

`live` spawns a real headless Claude agent (`claude -p`) against the real `@assay/mcp` server,
over the mission prompt in `apps/mcp/agent/prompt.md`. Nothing is scripted: the agent decides
which providers to consult, whether to pay, which claims to verify, and whether to challenge.
Two columns, refreshed together:

- **left** — the agent's own words: its reasoning text verbatim, each MCP tool call it chooses
  with its arguments, each tool's result. Never paraphrased.
- **right** — `@assay/dashboard`'s own `renderState()`, fed by the real `LoopEvent`s the live
  MCP server process streams out over the NDJSON sink (issue #93), not narration invented by
  this app.

`rehearsal` replays a captured `.scenic.ndjson` file (see below) at the exact pace it was
recorded, through the identical rendering pipeline, with `REPLAY` declared in the HUD
throughout. With no path given it picks the most recently captured file under
`apps/demo/captures/`.

## The transport (issue #93)

`claude` spawns the MCP server over stdio, so the loop's events happen in a different process
from anything that displays them, and stdout is the MCP protocol channel and cannot carry them.
`ASSAY_LOOP_EVENTS_SINK=<path>` makes `apps/mcp/src/index.ts` open that path
(`fs.createWriteStream(..., {flags:'a'})`) and write one NDJSON line per `LoopEvent`, using the
same `createEventStamper()` the node emits from so `seq` stays coherent. Unset (the default): no
sink, no behaviour change, exactly as core's hook already is when absent.

One companion wire beyond the issue's literal text: a second line shape, tagged `kind:
"heartbeat"`, carries `@assay/registry`'s `onReputationWriteAttempt` and `@assay/payments`'s
`onConfirmAttempt` ticks — the two real sub-3-second (and sub-5-second) cadences that would
otherwise be invisible across the process boundary during the 8-25s ENS write and the ~4s
payment confirm. `apps/demo/src/scenic-loop-mapper.ts` feeds the reputation ones straight into
this app's already-tested `formatReputationHeartbeat()`, unchanged; only its input source moved
from an in-process callback to a parsed sink line.

`apps/demo/src/sink-tailer.ts` polls the file every 100ms, splits on newlines, and holds a
partial trailing line across polls exactly like `apps/mcp/scripts/run-agent.ts` already has to
for the agent's own stdout chunks. The sink file not existing yet is a normal pre-run state, not
an error.

**Proven, not asserted: a failing sink does not break a tool call.**
`apps/mcp/src/loop-event-sink.test.ts` drives `createLoopEventSink` against a path under a
directory that never exists, and asserts neither `sinkLoopEvent`/`sinkHeartbeat` ever throws,
and — the load-bearing case — that no `uncaughtException` escapes (an unhandled `Writable`
`'error'` event is fatal by default; the explicit `.on('error', ...)` listener is what turns a
broken sink into "narration silently stops" instead of "the process crashes mid-payment").

## The capability-wiring fix this needed first

Before this work, `liar.assay.eth`'s published manifest carried `capabilityId: "rugscore"` —
the *honest* capability's own id — because nothing had ever published it under anything else,
and `apps/mcp`'s live server only ever registered one capability. Calling `pay_and_call` on
`liar.assay.eth` therefore ran the honest code under a dishonest name: there was no live lie to
catch, only a rehearsed transcript of one.

Fixed by registering `createLyingRugScoreProvider({ graph }, { id: 'rugscore-liar' })` as a
*second* capability entry (`apps/mcp/src/index.ts`) and republishing `liar.assay.eth`'s manifest
with `capabilityId: 'rugscore-liar'` (`packages/registry/scripts/reset-demo-state.ts`). Verified
live after `reset-demo-state.ts` ran: `liar.assay.eth`'s manifest now reads
`capabilityId: "rugscore-liar"` on Sepolia, and a real `pay_and_call` against it dispatches to
the lying capability for real.

## The mission prompt

`apps/mcp/agent/prompt.md` is the literal text specified for this work: `list_providers` first,
weigh every signal (not just the headline score), decide which provider(s) to pay, **verify
every claim a job returned, not only the one that looks suspicious**, challenge if a claim comes
back false, `rate` if everything holds. It never names which provider lies or which claim to
check — SPEC.md §16's rule that "agentic must be real reasoning, not a hardcoded `if`" holds for
the prompt as much as the code. `scripts/run-agent.ts`'s `ALLOWED_TOOLS` was widened to match
(all eight tools the prompt names; `register_provider` excluded, the mission never asks for it).

## A real run, measured (2026-07-25)

One full `tsx src/index.ts live` run, real Sepolia/Hedera/Graph networks, no fixture anywhere.
Capture saved at `apps/demo/captures/2026-07-25T16-07-49-812Z-9d023c.scenic.ndjson` (committed,
force-added past the `.gitignore` rule, as the offline-rehearsal fallback).

**Total wall clock: 114.3s** (`result.duration_ms`), 19 turns, $0.69 API cost, exit 0.

The agent, entirely on its own:

1. Called `list_providers` and read both `rugscore.assay.eth` (score 78, 14 jobs, 0 slashes) and
   `liar.assay.eth` (score 88, 9 jobs, 1 slash, 11.1% slash ratio) before touching either.
2. Discovered, assessed, and paid **both** — reasoning explicitly that the higher headline score
   (88) was not automatically the safer bet given the slash on record, and that a second,
   independent read was worth the budget for a decision this size.
3. Verified **all five claims on both jobs**, not just the one that looked suspicious per the
   prompt's own instruction — ten `verify_claim` calls total.
4. On `liar.assay.eth`'s job, `liquidityUsd` came back **FALSE**: claimed `1,000,056.51` at
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
| 50.3 – 55.1s | 4.8s | pay `liar.assay.eth`: real payment, confirm in 4.2s |
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
`liar.assay.eth`'s bond in its *own* process, which exits before the agent ever runs; the live
MCP server the agent actually drives is a *third*, separate process, whose own payments port
never saw that `bondRef`. The old keypress runner never hit this because its `doChallenge`
re-bonded the sacrificial provider inside the *same* process immediately before challenging —
the scenic runner's live agent has no equivalent step, and adding one would mean spending a real
bond on every server start regardless of whether the agent ever challenges, which is out of
scope for #93/#94.

**What still landed for real despite that**: `settle()` runs the slash and the ENS reputation
write concurrently and neither depends on the other's outcome (#53) — so even though the slash
failed, the reputation write still landed for real: `liar.assay.eth`'s ENS reputation dropped
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

## The offline rehearsal (issue #94's requirement)

`apps/demo/src/scenic-capture.ts` records every raw line from both sources
(`{source: 'agent'|'loop', recordedAtMs, payload}`) to one `.scenic.ndjson` file, relative to
the run's own start. `rehearsal` replays it by waiting the exact recorded gap between
consecutive records before re-emitting each one, through the *same* parsing/mapping/framing code
the live run uses — not a second, parallel implementation. Verified: replaying the 2026-07-25
capture above reproduces the same 115s run, the same two-column content, and the same "network
looks stalled" warning at the same ~32s closing silence (a real gap in the original run, not an
artifact of replay).

## Launching it

```bash
./scripts/demo.sh reset       # ~57s, restores both providers. Never on stage.
bash -lc './scripts/demo.sh'  # live: a real agent, real networks, ~115s
./scripts/demo.sh rehearsal   # offline replay of the last capture
```

The wrapper exists because two separate things are needed and having only one is the common
failure. `CLAUDE_CODE_OAUTH_TOKEN` is exported **above** the interactive guard in `~/.bashrc`,
so a login shell has it and the agent can authenticate. `mise` (node, pnpm) is activated
**below** that guard, so a login shell does **not** have it. That means plain
`bash -lc 'pnpm ...'` fails with `pnpm: command not found`, which is what the docs used to
tell you to run.

## Before every run

The reputation records are real and every run changes them, so reset first:

```
pnpm --filter @assay/registry exec tsx scripts/reset-demo-state.ts
```

Takes ~35-60s (two providers, two real bonds, four ENS writes) and must end with
`read-back matches target: OK`. Do not run it while presenting.

| | reset to | why |
|---|---|---|
| `rugscore.assay.eth` | score 78, 14 jobs, 0 slashes, bond 6x price, `capabilityId: "rugscore"` | without it the agent correctly declines to pay and the run never gets past discover |
| `liar.assay.eth` | score 88, 9 jobs, 1 slash, bond 6x price, `capabilityId: "rugscore-liar"` | without the capability-id fix there is no live lie behind this name at all; without the reputation reset the score sits too low to visibly collapse again |

`apps/demo/src/scenic-runner.ts` checks `rugscore.assay.eth`'s live reputation before ever
spawning the agent (reusing `apps/demo/src/reset-check.ts`, kept exactly as it was) and refuses
to start with a clear message if it would make the agent's own pay decision decline.

Checklist:

- [ ] `reset-demo-state.ts` run, `read-back matches target: OK`
- [ ] `CLAUDE_CODE_OAUTH_TOKEN` present in the shell that launches the agent (`~/.bashrc`; a
      non-login/non-interactive shell needs `bash -lc`, and needs `mise`'s node/pnpm on `PATH`
      too since mise's own activation sits behind an interactive guard)
- [ ] Hedera operator balance non-trivial
- [ ] one dry run of `pnpm --filter @assay/demo exec tsx src/index.ts rehearsal`, which needs no
      network and confirms the two-column narration renders at the same pace a live run will

## Fallback

The committed capture (`apps/demo/captures/2026-07-25T16-07-49-812Z-9d023c.scenic.ndjson`) is
the fallback if conference wifi dies mid-demo: `rehearsal` needs no network at all and reproduces
the exact run above, `REPLAY` declared in the HUD throughout.

Every claim on screen is independently checkable afterwards: HashScan for the Hedera
transactions, Sepolia Etherscan for the ENS writes, and the block numbers against The Graph
directly.

## What this replaced

Deleted entirely (issue #94's own instruction: "two demos where one is real is worse than one
demo"): `apps/demo/src/main.ts`, `session.ts`, `step-machine.ts`, `rehearsal.ts`,
`rehearsal-main.ts`, `screen.ts`, `fakes.ts`, `legend.ts`, and their tests — the whole
keypress-driven step machine. Kept, per #94's own list of what's genuinely reusable:
`reset-check.ts` (the readiness check), `@assay/dashboard`'s mapping (`createCoreEventMapper`,
now driven off parsed sink lines instead of an in-process callback), and
`scripts/capture-fixtures.ts` (the fixture capture for `@assay/dashboard`'s own fixtures,
unrelated to this app's runtime — its token/claim constants moved to the new
`token-fixtures.ts` since their previous home, `session.ts`, no longer exists).

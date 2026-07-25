# Demo run sheet

Everything below is measured, not estimated. Closes the open question in #53 (how to order
the closing beat around the ENS write latency) and is the input to the rehearsals in #31.

## The problem with the 90 second plan

SPEC §10 lays out a 90 second demo. The measured parts do not fit inside it, and the
biggest offender is not the one I expected:

| step | measured | SPEC §10 budget |
|---|---|---|
| agent: discover, reason, pay, serve | **42 to 57s** (5 runs) | ~30s (10-40s beats) |
| watchdog: serve, challenge, verify, slash, ENS write | **24.3s** | ~40s (40-80s beats) |
| ENS write alone, inside that | 12.4 to 24.6s, median 16.4 | not budgeted |
| Hedera payment, submit to confirmed | 4.1s | |
| Hedera slash, transfer alone | 0.4s | |

Two runs back to back is **66 to 81 seconds of machine time** with no narration, no
transitions, and nothing said out loud. There is no version of this that also fits an
introduction and a closing line into 90 seconds.

I had been treating the ENS write as the thing to engineer around. It is not. **The agent's
own reasoning is the longest step**, at 29 to 57 seconds depending on the run, and it is the
one step that must not be cut, because it is the entire point of the Hedera and MCP claims.
Making it faster would mean making it dumber.

## The decision

**Run the agent before the clock starts, and narrate the closing beat over the ENS write.**

Concretely:

1. **Start the requester agent during the introduction**, while explaining what Assay is.
   Its output streams to screen as it arrives, so the audience watches it reason in real
   time instead of watching a spinner. This buys back the 40-plus seconds that otherwise
   dominate the demo, and costs nothing: the agent's reasoning *is* the interesting content,
   it just does not need silence.
2. **The verifier's verdict is the reveal, not the slash.** The moment worth pausing on is
   two numbers side by side at the same block: the provider claimed `liquidityUsd` of
   1,000,056, the chain says 56.51. That lands in under a second and needs no waiting.
3. **The slash lands in 0.4s**, immediately after, with a HashScan link. Fast enough to
   feel like a consequence rather than a separate step.
4. **The ENS write then runs for 12 to 25 seconds, and that is the closing narration.**
   Say the closing line over it: reputation here is not stars, it is stake, and what you are
   watching is a public record being updated. The dashboard shows a real heartbeat every 3
   seconds off `onSettleProgress`, so the screen is alive rather than frozen, and the write
   confirming is the last thing that happens.

Step 4 is the actual answer to #53. The latency cannot be removed, so it gets the one part
of the demo that is words rather than waiting. Do not try to fill it with a further
technical step: if the ENS write hits its 24 second worst case, anything queued behind it
overruns.

**Realistic total: about 2 minutes.** Plan for that. If a hard 90 seconds is required, cut
the honest-provider counter-example from the live run and describe it verbally instead,
because it is the cheapest thing to lose and the recorded clip can carry it.

## Before every run

The reputation records are real and every rehearsal changes them, so reset first:

```
pnpm --filter @assay/registry exec tsx scripts/reset-demo-state.ts
```

Takes ~25s (bond, then two ENS writes). It sets `rugscore.assay.eth` to score 78, jobs 14,
zero slashes, and a bond of 6x the price, then reads it back off the resolver and prints
`read-back matches target: OK`. **Do not run it on stage**, and do not skip it: without it
the agent correctly declines to pay and the opening beat cannot happen (#64).

The watchdog slashes `liar.assay.eth`, not `rugscore.assay.eth`, so rehearsing the climax
does not damage the record the opening depends on. Check that
`WATCHDOG_PROVIDER_NAME` is unset or points at the sacrificial name.

Checklist:

- [ ] `reset-demo-state.ts` run, `read-back matches target: OK`
- [ ] `apps/provider` running on the port in the manifest's `endpoint`
- [ ] `CLAUDE_CODE_OAUTH_TOKEN` present in the shell that launches the agent. It lives in
      `~/.bashrc`, so a non-login shell will not have it and the agent fails with
      `Not logged in`. Launch via `bash -lc`.
- [ ] Hedera operator balance non-trivial (`reset` alone posts a 30 HBAR bond; the account
      refills daily)
- [ ] one dry run of `pnpm --filter @assay/dashboard exec tsx src/index.ts slash 0`, which
      needs no network and confirms the narration renders

## Fallback

Record the clip (#31) after a rehearsal that went well, not before. The two things most
likely to fail live are conference wifi, which affects every step, and the ENS write
drifting to its 24 second worst case. Both are survivable with narration; a dead network is
not, which is what the clip is for.

Every claim on screen is independently checkable afterwards, which is worth saying out
loud: HashScan for the Hedera transactions, Etherscan for the ENS writes, and the
`verifierHash` in the manifest is reproducible with `sha256sum` over two source files.

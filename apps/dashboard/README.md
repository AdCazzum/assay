# @assay/dashboard

Narrates the Assay loop on screen (issue #30, SPEC.md §10). This is what the
audience and the judges look at while everything else in the demo happens.

## Design

A terminal UI, plain ANSI, no dependencies. It is a **sink fed by events**, not
something that drives or polls the loop:

- `events.ts` — the `LoopEvent` vocabulary (nine steps: register, discover,
  pay, serve, accept, challenge, verify, slash, reputation) and a pure fold
  (`reduceEvents`) into a `LoopState`.
- `render.ts` — pure `render(events)` / `renderState(state)`. No I/O, no
  clock. This is what is unit tested.
- `sink.ts` — the one impure part: `attach()` prints a full frame to a writer
  every time an event arrives (clearing the screen so it reads as one live
  view, not a scrolling log); `replay()` turns a fixture array into a paced
  async source for rehearsal.
- `fixtures/` — two canonical event sequences: `happy-path.ts` (register
  through accept, no challenge) and `slash.ts` (the lying-provider climax:
  challenge -> verify FALSE -> slash -> reputation drop).

Whoever wires the live demo (apps/mcp / apps/watchdog / apps/provider) pushes
`LoopEvent`s into an `AsyncIterable` and hands it to `attach()`; this package
never imports `@assay/core` and never calls out to a network.

## Running it

Rehearse a fixture with zero network, at demo pace (one event every 900ms by
default):

```
pnpm --filter @assay/dashboard exec tsx src/index.ts slash
pnpm --filter @assay/dashboard exec tsx src/index.ts happy 300   # or a custom delay in ms
```

## Testing

```
pnpm --filter @assay/dashboard test
```

The rendering is tested as a pure function of the event sequence: the
canonical happy-path and slash fixtures are asserted against directly (step
order, pending vs ok vs failed vs running, real artifacts present, the slash
banner, the honest "declared test harness" label on the lying provider), plus
a couple of ad hoc sequences for the failure and empty-state degrade paths.

## Sample output (slash sequence, `color: false`)

This is `render(SLASH_EVENTS, { color: false })`, i.e. what
`tsx src/index.ts slash` prints frame by frame minus the color codes and
screen clears, pasted here so it can be reviewed without running anything:

```
ASSAY — reputation + payment rail

[○] Register   (pending)
[✔] Discover   resolved rugscore.assay.eth: 5 HBAR/call, score 92, 0 slashes
      ens name: rugscore.assay.eth
      reputation: score 92, jobs 41, slashes 0
[✔] Pay        5 HBAR paid, confirmed via mirror node in 1.9s
      tx: 0.0.1234567@1784930500.222333444
      hashscan: https://hashscan.io/testnet/transaction/0.0.1234567@1784930500.222333444
[✔] Serve      [LYING PROVIDER, declared test harness] rugScore.run(TOKEN_RUG) -> score 88 (low risk)
      claim hasActiveMintRole: false  (claimed)
      atBlock: 21050900
      jobId: job-2
[✔] Accept     job-2 accepted optimistically, valid until challenged
[✔] Challenge  watchdog challenges job-2, claim "hasActiveMintRole"
      jobId: job-2
[✔] Verify     verdict: FALSE — claim does not match The Graph at the same block
      claimed: hasActiveMintRole = false
      actual (The Graph, block 21050900): hasActiveMintRole = true
[✔] Slash      50 HBAR bond slashed to the watchdog
  >>> BOND SLASHED <<<
      bondRef: bond-17-0.0.9695801@1784930101.987654321
      tx: 0.0.9695801@1784930610.555666777
      hashscan: https://hashscan.io/testnet/transaction/0.0.9695801@1784930610.555666777
[✔] Reputation rugscore.assay.eth reputation updated on ENS (Sepolia), live
      score: 92 -> 41 (-51)
      slashes: 0 -> 1
      ens tx: sepolia:0xabc123...def456
```

`Register` stays `pending` because the slash fixture starts mid-loop (a
provider already registered earlier); that is deliberate, not a bug: it shows
what a step that never fires looks like on screen.

## Not done here

- No live wiring to `@assay/core`/apps/mcp/apps/watchdog: whichever of those
  lands the real loop needs to emit `LoopEvent`s that shape as it runs. This
  package only defines the shape and the renderer.
  - What `@assay/core` now offers for exactly that (issue #53): `settle()`
    runs the Hedera slash and the ENS reputation write concurrently and
    reports both legs' progress through `AssayNodeConfig.onSettleProgress`
    (`'slashing'`/`'writing-reputation'` fire together, then each leg's own
    `-confirmed`/`-failed` tick fires the moment *that* leg lands, independent
    of the other). Paired with `@assay/registry`'s own
    `onReputationWriteAttempt` (submitted/pending-heartbeat/confirmed, bound
    at `createEnsRegistry` construction), whoever wires the live loop has
    everything needed to drive the `slash`/`reputation` steps below exactly
    like `fixtures/slash.ts` already renders them: `slash` flips to `ok` early
    while `reputation` keeps narrating heartbeats, then `reputation` lands.
    Verified live against real Sepolia/Hedera testnet transactions while
    building #53 (see that PR's `live_evidence`), by mapping those two hooks'
    ticks onto this package's own `LoopEvent`/`attach()` with no changes
    needed here — this package's renderer was already generic enough.
- No color-scheme/theming beyond the four ANSI colors used; not needed for a
  36h build.

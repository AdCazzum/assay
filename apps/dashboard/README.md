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
- `from-core.ts` — maps `@assay/core`'s own `LoopEvent` vocabulary
  (`packages/core/src/events.ts`, issue #83) onto this package's `LoopEvent`
  shape (issue #85). `createCoreEventMapper()` builds a stateful mapper (it
  remembers when a payment landed, so a later confirmation can report real
  elapsed seconds); `mapCoreEvent()` is the stateless one-off form used in
  tests. This is the **only** file here that imports `@assay/core` — every
  other module stays exactly as core-independent as before.
- `fixtures/` — two canonical event sequences, **captured from a real run**
  (`apps/demo/scripts/capture-fixtures.ts`, issue #85) rather than
  hand-written: `happy-path.ts` (discover through accept against the real
  good provider, no challenge) and `slash.ts` (the lying-provider climax:
  discover through the ENS reputation write, against the real sacrificial
  provider running `@assay/cap-rugscore`'s declared lying-provider harness).
  Every tx id, block number and claim value in them is genuine; regenerate
  them by re-running the capture script rather than hand-editing.

`apps/demo` is what actually drives this live: it composes the real adapters
and `@assay/core`'s loop, wires each `AssayNode`'s `onLoopEvent` through
`createCoreEventMapper()`, and pushes the mapped events into this package's
renderer. This package itself never imports a network client and never
drives the loop; `from-core.ts` is the one seam that knows core's vocabulary
exists, and even it only maps, it never calls anything.

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
screen clears, pasted here so it can be reviewed without running anything.
Every value below is real, captured live (see `fixtures/slash.ts`'s own doc
comment for when and how):

```
ASSAY — reputation + payment rail

[○] Register   (pending)
[✔] Discover   resolved vantage.assay.eth: 5 HBAR/call, score 88, 1 slashes
      ens name: vantage.assay.eth
      price: 5 HBAR
      reputation: score 88, jobs 9, slashes 1
      bond: 30 HBAR
[✔] Pay        paid, confirmed via mirror node in 4.3s
      tx: 0.0.9695801@1784984809.586986344
[✔] Serve      [LYING PROVIDER, declared test harness] rugscore.run() -> {"score":99}
      claim liquidityUsd: 1000056.5133489597
      claim ageBlocks: 7597
      claim txCount: 2
      claim volumeUsd: 0
      claim topPoolConcentrationPct: 100
      atBlock: 25609974
      jobId: job-1
[✔] Accept     job-1 accepted optimistically, valid until challenged
[✔] Challenge  challenge on claim "liquidityUsd" adjudicated
[✔] Verify     verdict: FALSE — claim "liquidityUsd" did not hold up. claimed liquidityUsd=1000056.5133489597 at block 25609974, but The Graph reports 56.51334895971466
      reason: claimed liquidityUsd=1000056.5133489597 at block 25609974, but The Graph reports 56.51334895971466
[✔] Slash      bond slashed to the challenger
  >>> BOND SLASHED <<<
      tx: 0.0.9695801@1784984811.289048011
[✔] Reputation reputation updated on ENS (Sepolia), confirmed after 28.6s
      score: 88 -> 58
      slashes: 1 -> 2
      ens tx: 0xf0ba3572f5a7c105126129911772d7a0c3cb3d238be145e0964aeaa543b5c0e9
```

`Register` stays `pending` because neither the fixture nor a real demo run
ever calls `AssayNode.register()`: registration (the bond + the two ENS
writes) is an operator action `packages/registry/scripts/reset-demo-state.ts`
performs ahead of time, not a beat either the fixture or `apps/demo`'s own
four keys narrate. That is deliberate, not a bug: it shows what a step that
never fires looks like on screen.

## Live wiring

`apps/demo` composes the real adapters, `@assay/core`'s loop and this
package: it wires each `AssayNode`'s `onLoopEvent` through
`from-core.ts`'s `createCoreEventMapper()` and pushes the mapped events into
this package's `render()` (via `apps/demo/src/screen.ts`, which also adds the
demo's own key-legend/status footer underneath the frame). See
`apps/demo/src/session.ts` and `apps/demo/src/main.ts` for exactly how, and
`docs/demo-run-sheet.md` for the running order. This package itself still
never imports a network client and never drives the loop — `from-core.ts` is
the one file here that knows core's vocabulary exists, and even it only maps,
it never calls anything.

## Not done here

- No color-scheme/theming beyond the four ANSI colors used; not needed for a
  36h build.

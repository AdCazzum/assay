# @assay/demo

Drives the whole Assay demo from one keyboard (issue #86). One screen, four
keys, no second terminal.

```
pnpm --filter @assay/demo exec tsx src/index.ts live        # real networks
pnpm --filter @assay/demo exec tsx src/index.ts rehearsal   # no network, paced fixture replay
```

## What it does

`[1] discover  [2] pay  [3] serve  [4] challenge  [q] quit` — press a key when
you are ready to talk about that beat; nothing auto-advances into the next
one, and a step already running cannot be restarted by a stray keypress (see
`step-machine.ts`).

- **discover** resolves the good provider (`rugscore.<ENS_PARENT_NAME>`) over
  the real `@assay/registry` adapter.
- **pay** pays that provider's real price on Hedera testnet and waits for
  mirror-node confirmation. This is a real payment and a real confirmation,
  made directly against `@assay/payments` rather than through
  `AssayNode.payAndCall()` — see `session.ts`'s module doc comment for why
  pay and serve had to be split into two keys the presenter controls
  separately, when the underlying core API only offers them combined.
- **serve** runs the real `rugscore` capability (a live Uniswap v3 subgraph
  query through `@assay/graph`) against the payment just confirmed.
- **challenge** re-bonds and serves a fresh job against the *sacrificial*
  provider (`liar.<ENS_PARENT_NAME>`) with `@assay/cap-rugscore`'s declared
  lying-provider harness (SPEC.md §11), then challenges it for real: the
  verifier re-derives the disputed claim from The Graph at the same block,
  the bond is slashed on Hedera, and the ENS reputation write lands. The
  provider's own re-bond/pay/serve preamble is deliberately not narrated (it
  would overwrite the good provider's rows on screen with the liar's) — only
  challenge/verify/slash/reputation show, and a synthetic "preparing the
  challenge..." line appears the instant the key is pressed so the screen
  never sits frozen during the ~15-20s preamble.

The ENS reputation write itself (8 to 25s, sometimes more) ticks a real
heartbeat roughly every 3 seconds off `@assay/registry`'s own
`onReputationWriteAttempt` hook (`reputation-heartbeat.ts`) — a *different*,
lower-level hook than `@assay/core`'s own `LoopEvent` stream, wired in
`main.ts` alongside it, so the closing beat reads as visible progress rather
than a frozen screen.

## Composition

- `live-node.ts` — builds two live `AssayNode`s (one honest, one running the
  lying-provider harness — a `CapabilityRegistry` can only register one
  capability per id, and both providers publish the same `capabilityId`) plus
  the raw registry/payments ports the pay step needs directly.
- `session.ts` — the live step runners (what each of the four keys actually
  does); `step-machine.ts` — the guard/advance sequencing shared with the
  offline rehearsal.
- `screen.ts` — the one screen: reuses `@assay/dashboard`'s pure `render()`
  and appends a status footer (key legend + guard rejections + "press N
  next") underneath it.
- `reset-check.ts` — the visible reset check (issue #64, #86): reads the good
  provider's live reputation and checks it against the same pay-decision
  policy the live pay step will apply. If it would decline, `main.ts` refuses
  to start with a clear message instead of failing halfway through act one.
- `rehearsal.ts`/`rehearsal-main.ts` — the offline mode: identical keys and
  guards, replaying slices of `@assay/dashboard`'s own captured fixtures
  (`HAPPY_PATH_EVENTS`/`SLASH_EVENTS`) at the run sheet's measured pace
  instead of making a network call. This is what makes the live path and the
  rehearsal path render identically: both push the same `LoopEvent` shapes
  into the same `Screen` through the same keyboard machine.
- `keys.ts` — raw stdin keypress reading (`node:readline`, no dependency).

## Fixtures

`scripts/capture-fixtures.ts` regenerates `@assay/dashboard`'s two fixtures
from a real live run (see that script's own doc comment for cost and usage).
Re-run `packages/registry/scripts/reset-demo-state.ts` afterward — capturing
the slash fixture really does slash the sacrificial provider's bond and drop
its reputation.

## Before running for real

Same checklist as `docs/demo-run-sheet.md`: `reset-demo-state.ts` has run,
`apps/provider` (or whatever the manifest's `endpoint` points at) is up if
anything outside this process needs to reach it, and the full live `.env` is
present (AGENTS.md "Networks & secrets"). `main.ts` itself checks the good
provider's live reputation before showing the keyboard and refuses to start
if it would make the pay step decline.

# The pitch deck

`index.html` is the two or three minutes before the live demo: what Assay is, what it
does, which networks it uses and why each one is load-bearing rather than decorative,
and which alternatives were checked and rejected on the way. Thirteen slides, then it
hands over to `/assay-demo`.

One self-contained file. No build, no dependencies, no network, nothing added to
`pnpm-lock.yaml`. Open it and present:

```bash
xdg-open docs/pitch/index.html     # or just double-click it, or drag it into a browser
```

It works from `file://`, so it survives dead conference wifi the same way the dashboard
replay does.

| key | |
|---|---|
| `→` `space` `click` | next slide (click the left third to go back) |
| `←` | previous |
| `1`-`9` | jump to a slide |
| `n` | speaker notes (one line per slide, why that slide exists) |
| `f` | full screen, or zen mode where the browser will not allow it (see below) |
| `esc` | leave zen mode |
| `p` | print the handout |

The URL hash tracks the slide, so a reload lands where you were.

## Present it from a browser, not from a preview pane

An editor's HTML preview usually runs the page in a sandboxed iframe, and the Fullscreen
API is blocked there. Emdash is one of these: it previews HTML with
`sandbox="allow-scripts"` and no `allow-fullscreen` token, so `requestFullscreen()`
rejects and nothing happens. The deck now catches that, falls back to hiding its own
footer so the slides get the pixels back, and says so on screen instead of failing
silently. It is still a fallback: on stage, open the file in a real browser.

## It fits the projector it is handed

A slide taller than the screen is scaled down, never up: the size in this file is the
designed size. That safety net was written in CSS and never wired, though. It scales a
`.fit` wrapper that no slide had, so it was resizing the kicker while the content it was
meant to rescue ran past `overflow: hidden` and was cut. Measured at 1920x1080, three
slides were losing their last line with nothing on screen to say so. The wrapper is now
built at load, so a slide that grows later costs a percent or two of scale instead of a
sentence. If you add to a slide, check it at the resolution you will present at.

## The handout

Printing does not print the slides. It prints a separate two-page leave-behind written
for someone reading it alone after the demo: the problem, the loop, the three networks,
what has actually run on live networks, the measured timings, the real/staged/missing
breakdown, and the four checks a judge can run without our credentials. Print to PDF
and it is A4.

## Keeping it honest

Every number on these slides is measured and traceable to something in the repo:

| claim | source |
|---|---|
| reputation 56 → 26 and 26 → 31, both directions | `README.md`, "What actually works" |
| ~4.1s pay, ~0.4s slash, ~1.7s anchor, 8.3-24.6s ENS write | `docs/demo-run-sheet.md`, `README.md` |
| 405 tests across 9 packages | `pnpm -r test` |
| the block-drift quote | `apps/mcp/agent/transcripts/`, via `docs/submission.md` §4 |
| USDC and GOODCAT signals | `docs/submission.md`, The Graph track write-up |
| Token API rewritten onto subgraphs, and the dropped signals | `FEEDBACK.md`, `packages/graph/README.md` |
| x402 and Agent Kit checked, then rejected | `packages/payments/README.md`, "Rail decision" |
| 12/12 anchors reproduce, 8/12 once tampered | `docs/evidence/README.md` |

If one of those changes, change the slide. A deck that drifts from the repo is worse
than no deck, because on stage it is the thing being checked.

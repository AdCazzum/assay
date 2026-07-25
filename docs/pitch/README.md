# The pitch deck

`index.html` is the two or three minutes before the live demo: what Assay is, what it
does, which networks it uses and why each one is load-bearing rather than decorative.
Twelve slides, then it hands over to `/assay-demo`.

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

## The handout

Printing does not print the slides. It prints a separate two-page leave-behind written
for someone reading it alone after the demo: the problem, the loop, the three networks,
what has actually run on live networks, the measured timings, the real/staged/missing
breakdown, and the three checks a judge can run without our credentials. Print to PDF
and it is A4.

## Keeping it honest

Every number on these slides is measured and traceable to something in the repo:

| claim | source |
|---|---|
| reputation 56 → 26 and 26 → 31, both directions | `README.md`, "What actually works" |
| ~4.1s pay, ~0.4s slash, 8.3-24.6s ENS write | `docs/demo-run-sheet.md` |
| 394 tests across 9 packages | `pnpm -r test` |
| the block-drift quote | `apps/mcp/agent/transcripts/`, via `docs/submission.md` §4 |
| USDC and GOODCAT signals | `docs/submission.md`, The Graph track write-up |

If one of those changes, change the slide. A deck that drifts from the repo is worse
than no deck, because on stage it is the thing being checked.

/**
 * The demo's one screen (issue #86: "one screen, no second terminal").
 * Reuses `@assay/dashboard`'s pure `render()` for the step frame — the
 * renderer built for #85 stays exactly what draws the loop — and appends a
 * status footer underneath it: the key legend and whatever `setStatus()`
 * last reported (a guard rejection, a step's own failure, "press N next").
 *
 * `@assay/dashboard`'s `attach()` only re-renders when a new `LoopEvent`
 * arrives off its `AsyncIterable`; this app also needs to redraw the moment
 * a *keypress* happens (including a rejected one — pressing "3" before "2"
 * has landed should visibly say so, not silently do nothing), which is not
 * an event in the dashboard's own vocabulary. So this class owns the
 * frame/writer/clear bookkeeping itself (a few lines, mirroring `sink.ts`'s
 * `attach()`) rather than stretching that function's contract to cover a
 * concern (session status, not loop narration) it was never meant to know
 * about.
 */

import { render } from '@assay/dashboard';
import type { LoopEvent, RenderOptions } from '@assay/dashboard';

export type Writer = { write(chunk: string): unknown };

const CLEAR_SCREEN = '\x1b[2J\x1b[H';

export type ScreenOptions = RenderOptions & {
  /** Defaults to `process.stdout`. Inject a fake in tests to capture frames instead of printing. */
  writer?: Writer;
  /** Defaults to `true`, matching `sink.ts`'s `attach()`. */
  clear?: boolean;
};

export class Screen {
  private readonly events: LoopEvent[] = [];
  private statusLines: readonly string[] = [];
  private readonly writer: Writer;
  private readonly clear: boolean;
  private readonly renderOpts: RenderOptions;

  constructor(opts: ScreenOptions = {}) {
    this.writer = opts.writer ?? process.stdout;
    this.clear = opts.clear ?? true;
    this.renderOpts = { color: opts.color, title: opts.title };
  }

  /** Appends one `LoopEvent` (already mapped to the dashboard's own shape) and redraws. */
  pushEvent(event: LoopEvent): void {
    this.events.push(event);
    this.redraw();
  }

  /** Replaces the footer (key legend + current status line) and redraws, with no new loop event. */
  setStatus(lines: readonly string[]): void {
    this.statusLines = lines;
    this.redraw();
  }

  private redraw(): void {
    const frame = render(this.events, this.renderOpts);
    const footer = this.statusLines.length > 0 ? `\n\n${this.statusLines.join('\n')}` : '';
    this.writer.write(`${this.clear ? CLEAR_SCREEN : ''}${frame}${footer}\n`);
  }
}

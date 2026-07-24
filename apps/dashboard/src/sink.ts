/**
 * The impure half of the dashboard: feeding an event source into `render()`
 * and printing frames to a writer. Everything here is deliberately thin;
 * `render.ts` carries all the logic that decides what a frame looks like.
 *
 * Issue #30 asks for the dashboard to be "a sink fed by events... not
 * something that drives the loop or polls it". `attach()` is that sink: it
 * consumes whatever `AsyncIterable<LoopEvent>` it is given (a live queue the
 * real loop pushes into, or `replay()` below for a scripted rehearsal) and
 * never calls back into it.
 */

import { render } from './render.js';
import type { LoopEvent } from './events.js';
import type { RenderOptions } from './render.js';

/** The minimal surface `attach` needs to print a frame. `process.stdout` satisfies this. */
export type Writer = { write(chunk: string): unknown };

const CLEAR_SCREEN = '\x1b[2J\x1b[H';

export type AttachOptions = RenderOptions & {
  /** Defaults to `process.stdout`. Inject a fake in tests to capture frames instead of printing. */
  writer?: Writer;
  /** Clears the screen before each frame so the dashboard reads as one live view rather than a scrolling log. Defaults to `true`. */
  clear?: boolean;
};

/**
 * Consumes `events` one at a time and re-renders the whole loop state (every
 * event seen so far, folded) to `writer` after each one. A step that never
 * fires simply stays `pending` in every frame; a step whose event carries
 * `status: 'failed'` renders as failed, both are the degrade-gracefully
 * requirement from issue #30 played out one event at a time, not a special
 * case here.
 */
export async function attach(events: AsyncIterable<LoopEvent>, opts: AttachOptions = {}): Promise<void> {
  const writer = opts.writer ?? process.stdout;
  const clear = opts.clear ?? true;
  const seen: LoopEvent[] = [];

  for await (const event of events) {
    seen.push(event);
    const frame = render(seen, { color: opts.color, title: opts.title });
    writer.write(clear ? `${CLEAR_SCREEN}${frame}\n` : `${frame}\n`);
  }
}

/**
 * Turns a plain `LoopEvent[]` fixture into an async iterable that yields one
 * event every `delayMs`, so a canonical sequence (see `fixtures/`) can be
 * rehearsed at demo pace with zero network involved (SPEC.md §14 budgets
 * three rehearsals before the real thing). `delayMs: 0` yields as fast as the
 * event loop allows, which is what the render tests use.
 */
export async function* replay(events: readonly LoopEvent[], delayMs = 0): AsyncGenerator<LoopEvent> {
  for (const event of events) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    yield event;
  }
}

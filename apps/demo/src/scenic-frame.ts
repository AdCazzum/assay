/**
 * Composes one full screen frame: the HUD line, the two-column body (agent
 * pane + `@assay/dashboard`'s `renderState()` verbatim for the loop pane),
 * and a footer. Pure -- no clock, no I/O -- so it can be unit-tested and so
 * `scenic-runner.ts` (the impure orchestrator: spawns `claude`, tails the
 * sink, owns the redraw timer) stays a thin shell around this.
 */

import { renderState, type LoopState } from '@assay/dashboard';
import { composeColumns, composeSeparator } from './scenic-compositor.js';
import { renderHud, type HudOptions } from './scenic-hud.js';

const LEFT_HEADER = 'AGENT (claude, live reasoning)';
const RIGHT_HEADER = 'LOOP (assay node — real chain state)';

export type SceneFrameOptions = {
  hud: HudOptions;
  /** Already-formatted, already-wrapped left-pane lines, oldest first. */
  agentLines: readonly string[];
  loopState: LoopState;
  /** Footer lines, e.g. sink freshness / agent turn count / the replay hint. */
  footerLines: readonly string[];
  totalWidth?: number;
};

export function composeSceneFrame(opts: SceneFrameOptions): string {
  const totalWidth = opts.totalWidth ?? 100;
  const hud = renderHud(opts.hud);
  const header = composeColumns([LEFT_HEADER], [RIGHT_HEADER], { totalWidth });
  const separator = composeSeparator({ totalWidth });
  // The loop pane's own title line (renderState's first line, "ASSAY —
  // reputation + payment rail") is redundant with this frame's own HUD title
  // and header row, so it is dropped here -- renderState's body (every step
  // row) is reused verbatim, its title line is not.
  const loopBody = renderState(opts.loopState, { color: true }).split('\n').slice(2);
  const body = composeColumns(opts.agentLines, loopBody, { totalWidth });
  const footer = opts.footerLines.length > 0 ? `\n${opts.footerLines.join('\n')}` : '';

  return `${hud}\n\n${header}\n${separator}\n${body}${footer}`;
}

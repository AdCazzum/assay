/**
 * The offline rehearsal entrypoint (issue #86: "a rehearsal mode with no
 * network, replaying a captured run at the same pace"). Same screen, same
 * keyboard, same four keys as `main.ts` — only the session underneath
 * differs (`rehearsal.ts`'s fixture-backed one instead of `session.ts`'s
 * live one). No `.env`, no `MissingConfigError`, no reset check: there is no
 * network here to be unready.
 */

import { LEGEND } from './legend.js';
import { createRehearsalSession } from './rehearsal.js';
import { keyFor } from './step-machine.js';
import { Screen } from './screen.js';
import { startKeyboard } from './keys.js';

export function main(): void {
  const screen = new Screen();
  const setStatusLine = (message: string): void => screen.setStatus([LEGEND, '[REHEARSAL — no network]', message]);

  const session = createRehearsalSession({
    push: (event) => screen.pushEvent(event),
    onStatus: setStatusLine,
  });

  setStatusLine(`ready. press ${keyFor('discover')} (discover) to begin.`);

  const keyboard = startKeyboard({
    onKey: (key) => session.handleKey(key),
    onQuit: () => {
      keyboard.stop();
      process.exit(0);
    },
  });
}

const isMain = process.argv[1] ? import.meta.url === `file://${process.argv[1]}` : false;
if (isMain) {
  main();
}

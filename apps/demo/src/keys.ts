/**
 * Raw stdin keypress reading (issue #86: "terminal, plain ANSI, no new
 * dependencies"). `node:readline`'s `emitKeypressEvents` plus raw mode is a
 * Node builtin, not a dependency; this is the whole surface the demo needs
 * to read single keystrokes without waiting for Enter.
 */

import readline from 'node:readline';

export type KeyboardHandle = {
  /** Restores the terminal's original raw-mode state and stops listening. Always call this before the process exits, or the shell is left in raw mode. */
  stop(): void;
};

export type KeyboardOptions = {
  /** Called with the raw character for every keypress except the quit keys below. */
  onKey(key: string): void;
  /** Called on `q`, `Q`, Escape, or Ctrl+C — every quit key this app recognizes, in one place, so `main.ts` doesn't have to special-case each. */
  onQuit(): void;
  /** Defaults to `process.stdin`. Inject a fake in tests. */
  input?: NodeJS.ReadStream;
};

/**
 * Starts listening. Puts `input` into raw mode when it is a real TTY (a
 * piped/non-interactive stdin, e.g. in CI, is left alone — there is no raw
 * mode to enter, and `readline.emitKeypressEvents` still delivers whole-line
 * input as a sequence of keypresses on `\n`, which is enough for the tests).
 */
export function startKeyboard(opts: KeyboardOptions): KeyboardHandle {
  const input = opts.input ?? process.stdin;
  readline.emitKeypressEvents(input);
  const wasRaw = input.isTTY ? input.isRaw : undefined;
  if (input.isTTY) input.setRawMode(true);
  input.resume();
  if (typeof input.setEncoding === 'function') input.setEncoding('utf8');

  function onKeypress(str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): void {
    const isQuit = (key?.ctrl && key.name === 'c') || key?.name === 'q' || key?.name === 'escape' || str === 'q' || str === 'Q';
    if (isQuit) {
      opts.onQuit();
      return;
    }
    if (str) opts.onKey(str);
  }

  input.on('keypress', onKeypress);

  return {
    stop(): void {
      input.off('keypress', onKeypress);
      if (input.isTTY && wasRaw !== undefined) input.setRawMode(wasRaw);
      input.pause();
    },
  };
}

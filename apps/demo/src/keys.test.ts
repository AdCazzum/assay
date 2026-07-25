import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { startKeyboard } from './keys.js';

/** A `PassThrough` is a real `Readable`, so `readline.emitKeypressEvents` works on it exactly as it does on `process.stdin` — it just is never a TTY, so raw-mode toggling (only relevant to a real terminal) is a no-op here. */
function fakeTty(): NodeJS.ReadStream {
  const stream = new PassThrough();
  return stream as unknown as NodeJS.ReadStream;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('startKeyboard', () => {
  it('reports every non-quit keystroke via onKey', async () => {
    const input = fakeTty();
    const keys: string[] = [];
    const handle = startKeyboard({ input, onKey: (k) => keys.push(k), onQuit: () => {} });

    input.write('1');
    input.write('2');
    input.write('4');
    await flush();

    expect(keys).toEqual(['1', '2', '4']);
    handle.stop();
  });

  it('routes q, Q and Ctrl+C to onQuit, not onKey', async () => {
    const input = fakeTty();
    const keys: string[] = [];
    let quit = 0;
    const handle = startKeyboard({ input, onKey: (k) => keys.push(k), onQuit: () => (quit += 1) });

    input.write('q');
    input.write('Q');
    input.write('\x03'); // Ctrl+C
    await flush();

    expect(keys).toEqual([]);
    expect(quit).toBe(3);
    handle.stop();
  });

  it('stops listening after stop()', async () => {
    const input = fakeTty();
    const keys: string[] = [];
    const handle = startKeyboard({ input, onKey: (k) => keys.push(k), onQuit: () => {} });
    handle.stop();

    input.write('1');
    await flush();

    expect(keys).toEqual([]);
  });
});

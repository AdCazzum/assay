import { describe, expect, it } from 'vitest';
import { attach, replay } from './sink.js';
import type { Writer } from './sink.js';
import type { LoopEvent } from './events.js';

class FakeWriter implements Writer {
  chunks: string[] = [];
  write(chunk: string): void {
    this.chunks.push(String(chunk));
  }
}

describe('replay', () => {
  it('yields every event from the source array, in order, with no network involved', async () => {
    const events: LoopEvent[] = [
      { step: 'register', status: 'ok', summary: 'a' },
      { step: 'discover', status: 'ok', summary: 'b' },
    ];

    const seen: LoopEvent[] = [];
    for await (const event of replay(events)) {
      seen.push(event);
    }

    expect(seen).toEqual(events);
  });
});

describe('attach', () => {
  it('renders one growing frame per event, never fewer frames than events', async () => {
    const events: LoopEvent[] = [
      { step: 'register', status: 'ok', summary: 'registered' },
      { step: 'discover', status: 'ok', summary: 'discovered' },
      { step: 'pay', status: 'failed', summary: 'timed out' },
    ];
    const writer = new FakeWriter();

    await attach(replay(events), { writer, color: false, clear: false });

    expect(writer.chunks).toHaveLength(3);
    expect(writer.chunks[0]).toContain('registered');
    expect(writer.chunks[0]).not.toContain('discovered');
    expect(writer.chunks[1]).toContain('discovered');
    expect(writer.chunks[2]).toContain('timed out');
  });

  it('clears the screen before each frame unless told not to', async () => {
    const events: LoopEvent[] = [{ step: 'register', status: 'ok', summary: 'registered' }];
    const writer = new FakeWriter();

    await attach(replay(events), { writer, color: false, clear: true });

    expect(writer.chunks[0].startsWith('\x1b[2J\x1b[H')).toBe(true);
  });

  it('renders a failed event as visibly failed rather than freezing', async () => {
    const events: LoopEvent[] = [
      { step: 'pay', status: 'running', summary: 'paying...' },
      { step: 'pay', status: 'failed', summary: 'mirror node timed out' },
    ];
    const writer = new FakeWriter();

    await attach(replay(events), { writer, color: false, clear: false });

    const lastFrame = writer.chunks.at(-1)!;
    expect(lastFrame).toContain('✘');
    expect(lastFrame).toContain('mirror node timed out');
  });
});

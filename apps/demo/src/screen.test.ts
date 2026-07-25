import { describe, expect, it } from 'vitest';
import { Screen } from './screen.js';
import type { Writer } from './screen.js';
import type { LoopEvent } from '@assay/dashboard';

class FakeWriter implements Writer {
  chunks: string[] = [];
  write(chunk: string): void {
    this.chunks.push(String(chunk));
  }
}

describe('Screen', () => {
  it('renders a growing frame per pushed event, via the real @assay/dashboard render()', () => {
    const writer = new FakeWriter();
    const screen = new Screen({ writer, color: false, clear: false });

    screen.pushEvent({ step: 'discover', status: 'ok', summary: 'resolved rugscore.assay.eth' });
    expect(writer.chunks.at(-1)).toContain('resolved rugscore.assay.eth');
    expect(writer.chunks.at(-1)).toContain('Discover');

    screen.pushEvent({ step: 'pay', status: 'running', summary: 'paying...' });
    expect(writer.chunks.at(-1)).toContain('resolved rugscore.assay.eth'); // discover row still visible
    expect(writer.chunks.at(-1)).toContain('paying...');
  });

  it('appends the status footer under the frame, and updates it without needing a new event', () => {
    const writer = new FakeWriter();
    const screen = new Screen({ writer, color: false, clear: false });

    screen.setStatus(['ASSAY legend', 'press 1 first']);
    expect(writer.chunks.at(-1)).toContain('ASSAY legend');
    expect(writer.chunks.at(-1)).toContain('press 1 first');

    screen.setStatus(['ASSAY legend', 'press 2 next']);
    expect(writer.chunks.at(-1)).toContain('press 2 next');
    expect(writer.chunks.at(-1)).not.toContain('press 1 first');
  });

  it('clears the screen before each frame unless told not to', () => {
    const writer = new FakeWriter();
    const screen = new Screen({ writer, color: false, clear: true });
    screen.pushEvent({ step: 'discover', status: 'ok', summary: 'x' });
    expect(writer.chunks[0].startsWith('\x1b[2J\x1b[H')).toBe(true);
  });

  it('a failed event renders as visibly failed, never dropped by a later status-only redraw', () => {
    const writer = new FakeWriter();
    const screen = new Screen({ writer, color: false, clear: false });
    const failed: LoopEvent = { step: 'pay', status: 'failed', summary: 'declined' };
    screen.pushEvent(failed);
    screen.setStatus(['legend', 'retry?']);
    expect(writer.chunks.at(-1)).toContain('✘');
    expect(writer.chunks.at(-1)).toContain('declined');
  });
});

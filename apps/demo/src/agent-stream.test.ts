import { describe, expect, it } from 'vitest';
import { createAgentTranscript } from './agent-stream.js';

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe('createAgentTranscript', () => {
  it('renders a text block verbatim, trimmed, never paraphrased', () => {
    const transcript = createAgentTranscript();
    const out = transcript.handleLine(
      line({
        type: 'assistant',
        message: { id: 'm1', content: [{ type: 'text', text: "  I'll start by checking list_providers.  " }] },
      }),
    );
    expect(out).toEqual([{ kind: 'text', text: "I'll start by checking list_providers." }]);
  });

  it('renders a tool_use as name(args), stripping the mcp__assay__ prefix', () => {
    const transcript = createAgentTranscript();
    const out = transcript.handleLine(
      line({
        type: 'assistant',
        message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__assay__discover', input: { capabilityId: 'rugscore.assay.eth' } }] },
      }),
    );
    expect(out).toEqual([{ kind: 'tool-call', text: 'discover({"capabilityId":"rugscore.assay.eth"})' }]);
  });

  it('correlates a tool_result to its tool_use by id, not by adjacency', () => {
    const transcript = createAgentTranscript();
    transcript.handleLine(
      line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_42', name: 'mcp__assay__verify_claim', input: {} }] } }),
    );
    const out = transcript.handleLine(
      line({ type: 'user', message: { id: 'u1', content: [{ type: 'tool_result', tool_use_id: 'toolu_42', content: 'FALSE: claimed 1000056.51, chain reports 56.51' }] } }),
    );
    expect(out).toEqual([{ kind: 'tool-result', isError: false, text: 'verify_claim: FALSE: claimed 1000056.51, chain reports 56.51' }]);
  });

  it('marks an errored tool_result distinctly', () => {
    const transcript = createAgentTranscript();
    transcript.handleLine(
      line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_9', name: 'mcp__assay__pay_and_call', input: {} }] } }),
    );
    const out = transcript.handleLine(
      line({ type: 'user', message: { id: 'u1', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', is_error: true, content: 'PayDeclinedError: bond too small' }] } }),
    );
    expect(out).toEqual([{ kind: 'tool-result', isError: true, text: 'pay_and_call ERROR: PayDeclinedError: bond too small' }]);
  });

  it('a thinking block yields no visible content (established fact: every observed one is empty)', () => {
    const transcript = createAgentTranscript();
    const before = transcript.activity.lastActivityAt;
    const out = transcript.handleLine(
      line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: '', signature: 'abc123' }] } }),
    );
    expect(out).toEqual([]);
    expect(transcript.activity.lastActivityAt).toBeGreaterThanOrEqual(before);
  });

  it('tracks the thinking_tokens estimate as ephemeral activity, never as a pane line', () => {
    const transcript = createAgentTranscript();
    const out = transcript.handleLine(line({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 150 }));
    expect(out).toEqual([]);
    expect(transcript.activity.lastThinkingTokenEstimate).toBe(150);
  });

  it('a fresh content block clears the stale thinking_tokens estimate', () => {
    const transcript = createAgentTranscript();
    transcript.handleLine(line({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 250 }));
    expect(transcript.activity.lastThinkingTokenEstimate).toBe(250);
    transcript.handleLine(
      line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'ok' }] } }),
    );
    expect(transcript.activity.lastThinkingTokenEstimate).toBeUndefined();
  });

  it('the terminal result line marks the transcript finished and renders its own text as a verdict line', () => {
    const transcript = createAgentTranscript();
    const out = transcript.handleLine(
      line({ type: 'result', is_error: false, result: 'VERDICT: CHALLENGED\nprovider/liquidityUsd' }),
    );
    expect(out).toEqual([{ kind: 'verdict', text: 'VERDICT: CHALLENGED\nprovider/liquidityUsd' }]);
    expect(transcript.activity.finished).toBe(true);
    expect(transcript.activity.isError).toBe(false);
  });

  it('never throws on unparsable or unrecognized lines', () => {
    const transcript = createAgentTranscript();
    expect(transcript.handleLine('not json at all')).toEqual([]);
    expect(transcript.handleLine(line({ type: 'something-unexpected' }))).toEqual([]);
  });
});

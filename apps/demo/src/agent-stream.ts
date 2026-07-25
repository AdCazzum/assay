/**
 * Turns the real headless Claude agent's `stream-json` NDJSON output (the
 * exact wire `apps/mcp/scripts/run-agent.ts` already captures) into lines
 * this app's left pane renders. "The agent's own words are the star" (the
 * hard rule): every line below either quotes the model's own `text` verbatim
 * or names exactly which tool it called with exactly what arguments — never
 * a paraphrase, never an invented label standing in for what it actually
 * said.
 *
 * The established facts this is written against (verified live across 7
 * transcripts, see the design doc): one NDJSON line per *completed content
 * block*, not per turn and not a token-by-token delta; every observed
 * `thinking` block carries an empty `thinking` string (the model's real
 * visible reasoning lives entirely in `text` blocks, which land as one large
 * complete chunk after a silence); `tool_use`/`tool_result` correlate by
 * `id`/`tool_use_id`, not by adjacency (a future prompt allowing parallel
 * tool calls needs that, so this is written for it from the start even
 * though every transcript observed so far is strictly sequential);
 * `system/thinking_tokens` lines are a coarse, content-free "still alive"
 * heartbeat, never rendered as content.
 *
 * Deliberately loose types (`ContentBlock`/`StreamEvent`), the same posture
 * `run-agent.ts` already takes: this only renders best-effort from whatever
 * shape `claude --output-format stream-json` actually emits, it never drives
 * program logic, so a shape that doesn't exactly match should degrade
 * gracefully rather than fail to typecheck or throw.
 */

export type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
  id?: string;
  tool_use_id?: string;
};

export type StreamEvent = {
  type?: string;
  subtype?: string;
  message?: { id?: string; content?: ContentBlock[] };
  [key: string]: unknown;
};

/** One renderable fact for the agent pane. `kind` is for the caller's own styling; `text` is always ready to print as-is (already wrapped/joined). */
export type AgentPaneLine =
  | { kind: 'text'; text: string }
  | { kind: 'tool-call'; text: string }
  | { kind: 'tool-result'; text: string; isError: boolean }
  | { kind: 'status'; text: string }
  | { kind: 'verdict'; text: string };

/** Ephemeral "still working" facts that are not lines of their own -- rendered by the caller's own elapsed-time HUD logic, never as invented progress content (see the design doc's silence strategy). */
export type AgentActivity = {
  /** `Date.now()` of the last content block or status line this parser produced. */
  lastActivityAt: number;
  /** The most recent `system/thinking_tokens` estimate, if any has arrived since the last visible content. */
  lastThinkingTokenEstimate?: number;
  /** Whether the run has reached its terminal `type: "result"` line. */
  finished: boolean;
  /** Set once the terminal `result` line arrives. */
  isError?: boolean;
};

function toText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text ?? '') : ''))
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Stateful parser: one instance per agent run. Tracks the `tool_use.id ->
 * name` map (so a `tool_result` line, which only carries `tool_use_id`, can
 * still be rendered with the tool's name) and the activity/heartbeat facts
 * above, since neither is recoverable from a single line in isolation.
 */
export function createAgentTranscript() {
  const toolNameById = new Map<string, string>();
  const activity: AgentActivity = { lastActivityAt: Date.now(), finished: false };

  function touch(): void {
    activity.lastActivityAt = Date.now();
    activity.lastThinkingTokenEstimate = undefined;
  }

  /** Parses one raw NDJSON line into zero or more pane lines, and updates the activity state. Never throws: an unparsable or unrecognized line yields no pane lines. */
  function handleLine(raw: string): AgentPaneLine[] {
    let event: StreamEvent;
    try {
      event = JSON.parse(raw) as StreamEvent;
    } catch {
      return [];
    }

    const out: AgentPaneLine[] = [];

    if (event.type === 'system' && event.subtype === 'thinking_tokens') {
      const estimate = (event as { estimated_tokens?: number }).estimated_tokens;
      if (typeof estimate === 'number') activity.lastThinkingTokenEstimate = estimate;
      return out;
    }

    if (event.type === 'system' && event.subtype === 'init') {
      touch();
      out.push({ kind: 'status', text: 'session started' });
      return out;
    }

    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text?.trim()) {
          touch();
          out.push({ kind: 'text', text: block.text.trim() });
        } else if (block.type === 'tool_use') {
          touch();
          if (block.id && block.name) toolNameById.set(block.id, block.name);
          const shortName = (block.name ?? '(unknown)').replace(/^mcp__assay__/, '');
          out.push({ kind: 'tool-call', text: `${shortName}(${compactJson(block.input)})` });
        }
        // `thinking` blocks carry no renderable content (established fact:
        // every observed one is `thinking: ""`), so nothing is emitted for
        // them beyond the activity touch below -- a real reasoning beat is
        // happening, it just has nothing to quote.
        if (block.type === 'thinking') touch();
      }
      return out;
    }

    if (event.type === 'user' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_result') {
          touch();
          const name = block.tool_use_id ? toolNameById.get(block.tool_use_id) : undefined;
          const label = name ? name.replace(/^mcp__assay__/, '') : '(tool)';
          const isError = Boolean(block.is_error);
          out.push({
            kind: 'tool-result',
            isError,
            text: `${label}${isError ? ' ERROR' : ''}: ${toText(block.content).trim()}`,
          });
        }
      }
      return out;
    }

    if (event.type === 'result') {
      touch();
      activity.finished = true;
      activity.isError = Boolean((event as { is_error?: boolean }).is_error);
      const resultText = typeof event.result === 'string' ? event.result.trim() : '';
      if (resultText) out.push({ kind: 'verdict', text: resultText });
      return out;
    }

    return out;
  }

  return { handleLine, activity };
}

export type AgentTranscript = ReturnType<typeof createAgentTranscript>;

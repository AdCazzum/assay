/**
 * Greedy word-wrap, used only so a long agent reasoning paragraph (the star
 * of the left pane -- see the hard rule "show what it said, do not
 * paraphrase") becomes several short rows instead of one row the
 * compositor's own truncation (`scenic-compositor.ts`) would otherwise cut
 * down to a handful of characters. The compositor itself stays a dumb,
 * one-entry-per-row zipper on purpose (see its own doc comment); this is
 * where a caller that actually cares about not losing an agent's own words
 * pre-expands a long line into several short ones before handing them to it.
 */

export function wrapText(text: string, width: number, continuationIndent = ''): string[] {
  if (width <= continuationIndent.length) return [text];
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length === 0) {
      out.push('');
      continue;
    }
    const words = paragraph.split(' ');
    let current = '';
    let first = true;
    for (const word of words) {
      const prefix = first ? '' : continuationIndent;
      const candidate = current ? `${current} ${word}` : `${prefix}${word}`;
      if (candidate.length > width && current) {
        out.push(current);
        current = `${continuationIndent}${word}`;
        first = false;
      } else {
        current = candidate;
      }
    }
    if (current) out.push(current);
  }
  return out;
}

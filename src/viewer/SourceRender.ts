// Guardrails for rendering large source files. Shiki tokenizes synchronously on
// the main thread and its regex grammars backtrack pathologically on very long
// (minified) lines, so above these thresholds we skip highlighting and render
// plain lines instead. Starting values, tunable.
const maxHighlightBytes = 300_000;
const maxHighlightLines = 5000;
const maxHighlightLineLength = 2000;

const htmlEscapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

/** Whether a source file is too large to syntax-highlight responsively. */
export function isLargeSource(code: string): boolean {
  if (code.length > maxHighlightBytes) return true;
  const lines = code.split("\n");
  if (lines.length > maxHighlightLines) return true;
  return lines.some(line => line.length > maxHighlightLineLength);
}

/** Build highlighter-shaped HTML without tokenizing: one `.line` span per line,
 *  HTML-escaped, in the same `.shiki > pre > code` structure Shiki emits so the
 *  gutter overlay, line-number counters, scroll-to-line, and theming all keep
 *  working unchanged. */
export function plainSourceHtml(code: string): string {
  const body = code
    .split("\n")
    .map(line => `<span class="line">${escapeSourceHtml(line)}</span>`)
    .join("\n");
  return `<pre class="shiki"><code>${body}</code></pre>`;
}

/** Fast HTML escape for line text; a regex replace, not a DOM element per line
 *  (this runs once per line across files with thousands of lines). */
function escapeSourceHtml(s: string): string {
  return s.replace(/[&<>]/g, c => htmlEscapes[c]);
}

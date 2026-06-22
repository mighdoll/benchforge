/** Render a GitHub-flavored markdown pipe table: a header row, a `---`
 *  separator (one per column), then one row per cell array. Cells must not
 *  contain literal `|`, which would break the column boundaries. */
export function mdTable(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  return [line(headers), sep, ...rows.map(line)].join("\n");
}

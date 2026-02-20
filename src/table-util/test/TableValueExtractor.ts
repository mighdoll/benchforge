/** Extract numeric values from benchmark tables with Unicode borders. */

/** Extract a numeric value from a table by row name and column header. */
export function extractValue(
  table: string,
  row: string,
  column: string,
  group?: string,
): number | undefined {
  const lines = trimmedBody(table);
  const dataRow = lines.find(l => l.includes(row));
  if (!dataRow) return undefined;

  const colIndex = group
    ? getGroupColumnIndex(lines, group, column)
    : getColumnIndex(
        lines.find(line => line.includes(column)),
        column,
      );

  if (colIndex === undefined) return undefined;
  return parseCell(dataRow, colIndex);
}

/** @return the table lines w/borders and blank rows removed */
function trimmedBody(table: string): string[] {
  return table
    .split("\n")
    .filter(line => line.includes("║"))
    .map(line => line.replaceAll("║", "").trim())
    .filter(line => !line.match(/^[\s│]+$/));
}

/** Get the column index for a specific group and column combination. */
function getGroupColumnIndex(
  lines: string[],
  group: string,
  column: string,
): number | undefined {
  // assume the first line with the group or column name is the header line
  const groupLine = lines.find(line => line.includes(group));
  const columnLine = lines.find(line => line.includes(column));
  if (!columnLine || !groupLine) return undefined;

  const groupHeaders = splitColumnGroups(groupLine);
  const groupedColumns = splitColumnGroups(columnLine);

  const groupIndex = groupHeaders.findIndex(col => col.includes(group));
  if (groupIndex === -1) return undefined;

  const columnsBefore = countColumnsBeforeGroup(groupedColumns, groupIndex);
  const columnHeaders = splitColumns(columnLine);
  return columnHeaders.findIndex(
    (c, i) => c.includes(column) && i >= columnsBefore,
  );
}

/** Count total columns in groups before the target group index. */
function countColumnsBeforeGroup(
  headers: string[],
  groupIndex: number,
): number {
  const perGroup = headers.map(col => splitColumns(col).length);
  return perGroup.slice(0, groupIndex).reduce((sum, n) => sum + n, 0);
}

/** Find a column's position index in a header line. */
function getColumnIndex(
  header: string | undefined,
  column: string,
): number | undefined {
  if (!header) return undefined;

  const columns = splitColumns(header);
  const index = columns.findIndex(col => col.includes(column));
  return index !== -1 ? index : undefined;
}

/** Extract and parse the numeric value from a cell at the given column index. */
function parseCell(row: string, index: number): number | undefined {
  const text = splitColumns(row)[index];
  if (!text) return undefined;
  const match = text.match(/[\d,]+\.?\d*/);
  if (!match) return undefined;
  const value = Number.parseFloat(match[0].replace(/,/g, ""));
  return Number.isNaN(value) ? undefined : value;
}

/** split column groups along '│' borders */
function splitColumnGroups(line: string): string[] {
  return line.split("│").map(col => col.trim());
}

/** Split on 2+ whitespace or '│' borders, so single-space titles like "L1 miss" survive. */
function splitColumns(line: string): string[] {
  return line
    .split(/(?:[\s│]{2,}|│)/)
    .map(col => col.trim())
    .filter(Boolean);
}

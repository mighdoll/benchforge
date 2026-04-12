import type { Alignment, SpanningCellConfig, TableUserConfig } from "table";
import { table } from "table";
import colors from "../Colors.ts";
import { diffPercent } from "../Formatters.ts";

/** Named group of columns, rendered with an optional spanning header. */
export interface ColumnGroup<T> {
  groupTitle?: string;
  columns: AnyColumn<T>[];
}

export type AnyColumn<T> = Column<T> | DiffColumn<T>;

/** Table column with a value formatter (non-diff). */
export interface Column<T> extends ColumnFormat<T> {
  formatter?: (value: unknown) => string | null;
  diffKey?: undefined;
}

/** Pre-computed header rows and table config for the `table` library. */
export interface TableSetup {
  headerRows: string[][];
  config: TableUserConfig;
}

/** Group of result rows with an optional baseline for diff columns. */
export interface ResultGroup<T extends Record<string, any>> {
  results: T[];
  baseline?: T;
}

interface DiffColumn<T> extends ColumnFormat<T> {
  diffFormatter?: (value: unknown, baseline: unknown) => string | null;
  formatter?: undefined;
  diffKey: keyof T;
}

interface ColumnFormat<T> {
  key: keyof T;
  title: string;
  alignment?: Alignment;
  width?: number;
}

interface Lines {
  drawHorizontalLine: (index: number, size: number) => boolean;
  drawVerticalLine: (index: number, size: number) => boolean;
}

const { bold } = colors;

const ansiEscapeRegex = new RegExp(
  String.fromCharCode(27) + "\\[[0-9;]*m",
  "g",
);

/** Build formatted table with column groups and baseline diffs. */
export function buildTable<T extends Record<string, any>>(
  columnGroups: ColumnGroup<T>[],
  resultGroups: ResultGroup<T>[],
  nameKey: keyof T = "name" as keyof T,
): string {
  const allRecords = flattenGroups(columnGroups, resultGroups, nameKey);
  return createTable(columnGroups, allRecords);
}

/** Convert records to string arrays for table rendering. */
export function toRows<T extends Record<string, any>>(
  records: T[],
  groups: ColumnGroup<T>[],
): string[][] {
  const allColumns = groups.flatMap(group => group.columns);

  const rawRows = records.map(record =>
    allColumns.map(col => {
      const value = record[col.key];
      return col.formatter ? col.formatter(value) : value;
    }),
  );

  return rawRows.map(row => row.map(cell => cell ?? " "));
}

/** Flatten result groups into a single array, inserting blank separator rows. */
function flattenGroups<T extends Record<string, any>>(
  groups: ColumnGroup<T>[],
  resultGroups: ResultGroup<T>[],
  nameKey: keyof T,
): T[] {
  return resultGroups.flatMap((group, i) => {
    const records = addBaseline(groups, group, nameKey);
    const isLast = i === resultGroups.length - 1;
    return isLast ? records : [...records, {} as T];
  });
}

/** Render column groups and records into a formatted table string. */
function createTable<T extends Record<string, any>>(
  groups: ColumnGroup<T>[],
  records: T[],
): string {
  const dataRows = toRows(records, groups);
  const { headerRows, config } = buildTableConfig(groups, dataRows);
  const allRows = [...headerRows, ...dataRows];
  return table(allRows, config);
}

/** Append baseline row and inject diff values into result rows. */
function addBaseline<T extends Record<string, any>>(
  groups: ColumnGroup<T>[],
  group: ResultGroup<T>,
  nameKey: keyof T,
): T[] {
  const { results, baseline } = group;
  if (!baseline) return results;
  const diffResults = results.map(r => addComparisons(groups, r, baseline));
  const marked = { ...baseline, [nameKey]: `--> ${baseline[nameKey]}` };
  return [...diffResults, marked];
}

/** Build header rows, spanning cells, column widths, and border rules. */
function buildTableConfig<T>(
  groups: ColumnGroup<T>[],
  dataRows: string[][],
): TableSetup {
  const titles = getTitles(groups);
  const headerRows = [...createGroupHeaders(groups, titles.length), titles];
  const config: TableUserConfig = {
    spanningCells: createSectionSpans(groups),
    columns: calcColumnWidths(groups, titles, dataRows),
    ...createLines(groups),
  };
  return { headerRows, config };
}

/** Compute formatted diff values by comparing a row against baseline. */
function addComparisons<T extends Record<string, any>>(
  groups: ColumnGroup<T>[],
  main: T,
  baseline: T,
): T {
  const cols = groups
    .flatMap(g => g.columns)
    .filter((col): col is DiffColumn<T> => col.diffKey !== undefined);
  const diffs = Object.fromEntries(
    cols.map(col => {
      const fmt = col.diffFormatter ?? diffPercent;
      return [col.key, fmt(main[col.diffKey], baseline[col.diffKey])];
    }),
  );
  return { ...main, ...diffs };
}

/** @return bolded column title strings */
function getTitles<T>(groups: ColumnGroup<T>[]): string[] {
  return groups.flatMap(g => g.columns.map(c => bold(c.title || " ")));
}

/** @return header rows with group titles, or empty if no groups have titles. */
function createGroupHeaders<T>(
  groups: ColumnGroup<T>[],
  numColumns: number,
): string[][] {
  if (!groups.some(g => g.groupTitle)) return [];

  const sectionRow = groups.flatMap(g => {
    const title = g.groupTitle ? [bold(g.groupTitle)] : [];
    return padWithBlanks(title, g.columns.length);
  });
  const blankRow = padWithBlanks([], numColumns);
  return [sectionRow, blankRow];
}

/** @return spanning cell configs for group title headers */
function createSectionSpans<T>(groups: ColumnGroup<T>[]): SpanningCellConfig[] {
  const offsets = groupOffsets(groups);
  return groups.map((g, i) => ({
    row: 0,
    col: offsets[i],
    colSpan: g.columns.length,
    alignment: "center" as Alignment,
  }));
}

/** Calculate column widths based on content, widening to fit group titles. */
function calcColumnWidths<T>(
  groups: ColumnGroup<T>[],
  titles: string[],
  dataRows: unknown[][],
): Record<number, { width: number; wrapWord: boolean }> {
  const maxData = (i: number) =>
    dataRows.reduce((m, row) => Math.max(m, cellWidth(row[i])), 0);
  const widths = titles.map((t, i) => Math.max(cellWidth(t), maxData(i)));

  // Widen columns so group titles fit (accounting for " | " separators)
  const offsets = groupOffsets(groups);
  for (const [i, group] of groups.entries()) {
    const titleWidth = cellWidth(group.groupTitle);
    if (titleWidth <= 0) continue;
    const col = offsets[i];
    const n = group.columns.length;
    const sepWidth = (n - 1) * 3;
    const curWidth = widths.slice(col, col + n).reduce((a, b) => a + b, 0);
    const needed = titleWidth - curWidth - sepWidth;
    if (needed > 0) widths[col + n - 1] += needed;
  }

  return Object.fromEntries(
    widths.map((w, i) => [i, { width: w, wrapWord: false }]),
  );
}

/** @return draw functions for horizontal/vertical table borders */
function createLines<T>(groups: ColumnGroup<T>[]): Lines {
  const { sectionBorders, headerBottom } = calcBorders(groups);
  return {
    drawVerticalLine: (i, size) =>
      i === 0 || i === size || sectionBorders.includes(i),
    drawHorizontalLine: (i, size) =>
      i === 0 || i === size || i === headerBottom,
  };
}

/** @return array padded with blank strings to the given length */
function padWithBlanks(arr: string[], length: number): string[] {
  if (arr.length >= length) return arr;
  return [...arr, ...Array(length - arr.length).fill(" ")];
}

/** @return cumulative column offsets for each group boundary */
function groupOffsets<T>(groups: ColumnGroup<T>[]): number[] {
  let offset = 0;
  return groups.map(g => {
    const start = offset;
    offset += g.columns.length;
    return start;
  });
}

/** @return visible length of a cell value, stripping ANSI escape codes. */
function cellWidth(value: unknown): number {
  if (value == null) return 0;
  const str = String(value);
  return str.replace(ansiEscapeRegex, "").length;
}

/** @return vertical line positions between sections and header bottom row. */
function calcBorders<T>(groups: ColumnGroup<T>[]) {
  const offsets = groupOffsets(groups);
  const sectionBorders = offsets.map((o, i) => o + groups[i].columns.length);
  const headerBottom = groups.length === 0 ? 1 : 3;
  return { sectionBorders, headerBottom };
}

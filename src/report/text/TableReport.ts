import type { Alignment, SpanningCellConfig, TableUserConfig } from "table";
import { table } from "table";
import colors from "../Colors.ts";
import { diffPercent } from "../Formatters.ts";

/** Related table columns */
export interface ColumnGroup<T> {
  groupTitle?: string;
  columns: AnyColumn<T>[];
}

export type AnyColumn<T> = Column<T> | DiffColumn<T>;

/** Column with optional formatter */
export interface Column<T> extends ColumnFormat<T> {
  formatter?: (value: unknown) => string | null;
  diffKey?: undefined;
}

/** Table headers and configuration */
export interface TableSetup {
  headerRows: string[][];
  config: TableUserConfig;
}

/** Data rows with optional baseline */
export interface ResultGroup<T extends Record<string, any>> {
  results: T[];

  baseline?: T;
}

/** Comparison column against baseline */
interface DiffColumn<T> extends ColumnFormat<T> {
  diffFormatter?: (value: unknown, baseline: unknown) => string | null;
  formatter?: undefined;

  /** Key for comparison value against baseline */
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

// Regex to strip ANSI escape codes (ESC [ ... m sequences)
const ansiEscapeRegex = new RegExp(
  String.fromCharCode(27) + "\\[[0-9;]*m",
  "g",
);

/** Build formatted table with column groups and baselines */
export function buildTable<T extends Record<string, any>>(
  columnGroups: ColumnGroup<T>[],
  resultGroups: ResultGroup<T>[],
  nameKey: keyof T = "name" as keyof T,
): string {
  const allRecords = flattenGroups(columnGroups, resultGroups, nameKey);
  return createTable(columnGroups, allRecords);
}

/** Convert records to string arrays for table */
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

/** Flatten groups with spacing */
function flattenGroups<T extends Record<string, any>>(
  columnGroups: ColumnGroup<T>[],
  resultGroups: ResultGroup<T>[],
  nameKey: keyof T,
): T[] {
  return resultGroups.flatMap((group, i) => {
    const groupRecords = addBaseline(columnGroups, group, nameKey);

    const isLast = i === resultGroups.length - 1;
    return isLast ? groupRecords : [...groupRecords, {} as T];
  });
}

/** Convert columns and records to formatted table */
function createTable<T extends Record<string, any>>(
  groups: ColumnGroup<T>[],
  records: T[],
): string {
  const dataRows = toRows(records, groups);
  const { headerRows, config } = setup(groups, dataRows);
  const allRows = [...headerRows, ...dataRows];
  return table(allRows, config);
}

/** Process results with baseline comparisons */
function addBaseline<T extends Record<string, any>>(
  columnGroups: ColumnGroup<T>[],
  group: ResultGroup<T>,
  nameKey: keyof T,
): T[] {
  const { results, baseline } = group;

  if (!baseline) return results;

  const diffResults = results.map(result =>
    addComparisons(columnGroups, result, baseline),
  );

  const marked = { ...baseline, [nameKey]: `--> ${baseline[nameKey]}` };
  return [...diffResults, marked];
}

/** Create headers and table configuration */
function setup<T>(groups: ColumnGroup<T>[], dataRows: string[][]): TableSetup {
  const titles = getTitles(groups);
  const headerRows = [...createGroupHeaders(groups, titles.length), titles];
  const config: TableUserConfig = {
    spanningCells: createSectionSpans(groups),
    columns: calcColumnWidths(groups, titles, dataRows),
    ...createLines(groups),
  };
  return { headerRows, config };
}

/** Add comparison values for diff columns */
function addComparisons<T extends Record<string, any>>(
  groups: ColumnGroup<T>[],
  main: T,
  baseline: T,
): T {
  const diffCols = groups.flatMap(g => g.columns).filter(col => col.diffKey);
  const result = { ...main };

  for (const col of diffCols) {
    const dcol = col as DiffColumn<T>;
    const fmt = dcol.diffFormatter ?? diffPercent;
    (result as any)[col.key] = fmt(main[dcol.diffKey], baseline[dcol.diffKey]);
  }

  return result;
}

/** @return bolded column title strings */
function getTitles<T>(groups: ColumnGroup<T>[]): string[] {
  return groups.flatMap(g => g.columns.map(c => bold(c.title || " ")));
}

/** Create header rows with group titles */
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
  let col = 0;
  const alignment: Alignment = "center";
  return groups.map(g => {
    const colSpan = g.columns.length;
    const span = { row: 0, col, colSpan, alignment };
    col += colSpan;
    return span;
  });
}

/** Calculate column widths based on content, including group titles */
function calcColumnWidths<T>(
  groups: ColumnGroup<T>[],
  titles: string[],
  dataRows: unknown[][],
): Record<number, { width: number; wrapWord: boolean }> {
  // First pass: calculate base widths from titles and data
  const maxData = (i: number) =>
    dataRows.reduce((m, row) => Math.max(m, cellWidth(row[i])), 0);
  const widths = titles.map((t, i) => Math.max(cellWidth(t), maxData(i)));

  // Second pass: ensure group titles fit (accounting for column separators)
  let col = 0;
  for (const group of groups) {
    const gw = cellWidth(group.groupTitle);
    const n = group.columns.length;
    if (gw > 0) {
      const sepWidth = (n - 1) * 3; // " | " between columns
      const curWidth = widths.slice(col, col + n).reduce((a, b) => a + b, 0);
      const needed = gw - curWidth - sepWidth;
      if (needed > 0) widths[col + n - 1] += needed;
    }
    col += n;
  }

  // Convert to table config format
  return Object.fromEntries(
    widths.map((w, i) => [i, { width: w, wrapWord: false }]),
  );
}

/** @return draw functions for horizontal/vertical table borders */
function createLines<T>(groups: ColumnGroup<T>[]): Lines {
  const { sectionBorders, headerBottom } = calcBorders(groups);

  return {
    drawVerticalLine: (index, size) =>
      index === 0 || index === size || sectionBorders.includes(index),
    drawHorizontalLine: (index, size) =>
      index === 0 || index === size || index === headerBottom,
  };
}

/** @return array padded with blank strings to the given length */
function padWithBlanks(arr: string[], length: number): string[] {
  if (arr.length >= length) return arr;
  return [...arr, ...Array(length - arr.length).fill(" ")];
}

/** Get visible length of a cell value (strips ANSI escape codes) */
function cellWidth(value: unknown): number {
  if (value == null) return 0;
  const str = String(value);
  return str.replace(ansiEscapeRegex, "").length;
}

/** Calculate vertical lines between sections and header bottom position */
function calcBorders<T>(groups: ColumnGroup<T>[]): {
  sectionBorders: number[];
  headerBottom: number;
} {
  if (groups.length === 0) return { sectionBorders: [], headerBottom: 1 };

  let border = 0;
  const sectionBorders = groups.map(g => (border += g.columns.length));
  return { sectionBorders, headerBottom: 3 };
}

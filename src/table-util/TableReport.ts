import pico from "picocolors";
import type { Alignment, SpanningCellConfig, TableUserConfig } from "table";
import { table } from "table";
import { diffPercent } from "./Formatters.ts";

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
const { bold } = isTest ? { bold: (str: string) => str } : pico;

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

/** Build formatted table with column groups and baselines */
export function buildTable<T extends Record<string, any>>(
  columnGroups: ColumnGroup<T>[],
  resultGroups: ResultGroup<T>[],
  nameKey: keyof T = "name" as keyof T,
): string {
  const allRecords = flattenGroups(columnGroups, resultGroups, nameKey);
  return createTable(columnGroups, allRecords);
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

interface Lines {
  drawHorizontalLine: (index: number, size: number) => boolean;
  drawVerticalLine: (index: number, size: number) => boolean;
}

/** @return draw functions for horizontal/vertical table borders */
function createLines<T>(groups: ColumnGroup<T>[]): Lines {
  const { sectionBorders, headerBottom } = calcBorders(groups);

  function drawVerticalLine(index: number, size: number): boolean {
    return index === 0 || index === size || sectionBorders.includes(index);
  }
  function drawHorizontalLine(index: number, size: number): boolean {
    return index === 0 || index === size || index === headerBottom;
  }
  return { drawHorizontalLine, drawVerticalLine };
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

/** @return bolded column title strings */
function getTitles<T>(groups: ColumnGroup<T>[]): string[] {
  return groups.flatMap(g => g.columns.map(c => bold(c.title || " ")));
}

/** @return array padded with blank strings to the given length */
function padWithBlanks(arr: string[], length: number): string[] {
  if (arr.length >= length) return arr;
  return [...arr, ...Array(length - arr.length).fill(" ")];
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

/** Add comparison values for diff columns */
function addComparisons<T extends Record<string, any>>(
  groups: ColumnGroup<T>[],
  mainRecord: T,
  baselineRecord: T,
): T {
  const diffColumns = groups.flatMap(g => g.columns).filter(col => col.diffKey);
  const updatedMain = { ...mainRecord };

  for (const col of diffColumns) {
    const dcol = col as DiffColumn<T>;
    const diffKey = dcol.diffKey;
    const mainValue = mainRecord[diffKey];
    const baselineValue = baselineRecord[diffKey];
    const diffFormat = dcol.diffFormatter ?? diffPercent;
    const diffStr = diffFormat(mainValue, baselineValue);
    (updatedMain as any)[col.key] = diffStr;
  }

  return updatedMain;
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

  const markedBaseline = {
    ...baseline,
    [nameKey]: `--> ${baseline[nameKey]}`,
  };

  return [...diffResults, markedBaseline];
}

/** Calculate vertical lines between sections and header bottom position */
function calcBorders<T>(groups: ColumnGroup<T>[]): {
  sectionBorders: number[];
  headerBottom: number;
} {
  if (groups.length === 0) return { sectionBorders: [], headerBottom: 1 };

  const sectionBorders: number[] = [];
  let border = 0;
  for (const g of groups) {
    border += g.columns.length;
    sectionBorders.push(border);
  }
  return { sectionBorders, headerBottom: 3 };
}

/** Create headers and table configuration */
function setup<T>(groups: ColumnGroup<T>[], dataRows: string[][]): TableSetup {
  const titles = getTitles(groups);
  const numColumns = titles.length;

  const sectionRows = createGroupHeaders(groups, numColumns);
  const headerRows = [...sectionRows, titles];
  const spanningCells = createSectionSpans(groups);
  const columnWidths = calcColumnWidths(groups, titles, dataRows);
  const config: TableUserConfig = {
    spanningCells,
    columns: columnWidths,
    ...createLines(groups),
  };

  return { headerRows, config };
}

/** Calculate column widths based on content, including group titles */
function calcColumnWidths<T>(
  groups: ColumnGroup<T>[],
  titles: string[],
  dataRows: unknown[][],
): Record<number, { width: number; wrapWord: boolean }> {
  // First pass: calculate base widths from titles and data
  const widths: number[] = [];
  for (let i = 0; i < titles.length; i++) {
    const titleW = cellWidth(titles[i]);
    const maxDataW = dataRows.reduce(
      (max, row) => Math.max(max, cellWidth(row[i])),
      0,
    );
    widths.push(Math.max(titleW, maxDataW));
  }

  // Second pass: ensure group titles fit (accounting for column separators)
  let colIndex = 0;
  for (const group of groups) {
    const groupW = cellWidth(group.groupTitle);
    if (groupW > 0) {
      const numCols = group.columns.length;
      const separatorWidth = (numCols - 1) * 3; // " | " between columns
      const currentWidth = widths
        .slice(colIndex, colIndex + numCols)
        .reduce((a, b) => a + b, 0);
      const needed = groupW - currentWidth - separatorWidth;
      if (needed > 0) {
        // Distribute extra width to last column in group
        widths[colIndex + numCols - 1] += needed;
      }
    }
    colIndex += group.columns.length;
  }

  // Convert to table config format
  return Object.fromEntries(
    widths.map((w, i) => [i, { width: w, wrapWord: false }]),
  );
}

// Regex to strip ANSI escape codes (ESC [ ... m sequences)
const ansiEscapeRegex = new RegExp(
  String.fromCharCode(27) + "\\[[0-9;]*m",
  "g",
);

/** Get visible length of a cell value (strips ANSI escape codes) */
function cellWidth(value: unknown): number {
  if (value == null) return 0;
  const str = String(value);
  return str.replace(ansiEscapeRegex, "").length;
}

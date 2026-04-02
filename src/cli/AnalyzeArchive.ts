/** Diagnostic analysis of a .benchforge archive's per-batch statistics. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import colors from "../report/Colors.ts";
import { timeMs } from "../report/Formatters.ts";
import { average, percentile } from "../stats/StatisticalUtils.ts";
import type { BenchmarkEntry, BenchmarkGroup } from "../viewer/ReportData.ts";

const { bold, dim, red, green, yellow, cyan } = colors;

/** Read an archive and print per-batch diagnostic analysis. */
export async function analyzeArchive(filePath: string): Promise<void> {
  const absPath = resolve(filePath);
  const content = await readFile(absPath, "utf-8");
  const archive = JSON.parse(content);
  const report = archive.report;
  if (!report?.groups?.length) {
    console.error("No report data found in archive.");
    return;
  }
  const batchCount = report.metadata?.cliArgs?.batches as number | undefined;
  for (const group of report.groups) {
    analyzeGroup(group, batchCount);
  }
}

function analyzeGroup(group: BenchmarkGroup, batchCount?: number): void {
  console.log(bold(`\n=== ${group.name} ===\n`));

  const baseline = group.baseline;
  for (const bench of group.benchmarks) {
    analyzeBenchmark(bench, baseline, batchCount);
  }
}

function analyzeBenchmark(
  bench: BenchmarkEntry,
  baseline: BenchmarkEntry | undefined,
  batchCount?: number,
): void {
  const bOffsets = bench.batchOffsets ?? inferOffsets(bench.samples, batchCount);
  const baseOffsets =
    baseline?.batchOffsets ?? inferOffsets(baseline?.samples, batchCount);

  if (!bOffsets?.length) {
    console.log(dim("  No batch data (single batch run)"));
    return;
  }

  const bBatches = splitBatches(bench.samples, bOffsets);
  const baseBatches =
    baseOffsets && baseline
      ? splitBatches(baseline.samples, baseOffsets)
      : undefined;

  const nBatches = bBatches.length;
  console.log(bold(`  ${bench.name}`) + dim(` (${nBatches} batches)`));

  // Per-batch medians
  printBatchTable(bBatches, baseBatches);

  // Order effect analysis
  if (baseBatches && baseBatches.length === nBatches) {
    printOrderEffect(bBatches, baseBatches);
    printPairedDeltas(bBatches, baseBatches);
  }
  console.log();
}

/** Infer equal-sized batch offsets when batchOffsets isn't in the archive. */
function inferOffsets(
  samples: number[] | undefined,
  batchCount?: number,
): number[] | undefined {
  if (!samples?.length || !batchCount || batchCount <= 1) return undefined;
  const size = Math.floor(samples.length / batchCount);
  return Array.from({ length: batchCount }, (_, i) => i * size);
}

/** Split flat samples into batches using offset boundaries. */
function splitBatches(samples: number[], offsets: number[]): number[][] {
  return offsets.map((start, i) => {
    const end = i + 1 < offsets.length ? offsets[i + 1] : samples.length;
    return samples.slice(start, end);
  });
}

/** Print per-batch median table for current and baseline. */
function printBatchTable(
  benches: number[][],
  baselines: number[][] | undefined,
): void {
  const header = baselines
    ? `  ${"batch".padEnd(7)} ${"n".padStart(4)}  ${"current".padStart(10)}  ${"baseline".padStart(10)}  ${"delta".padStart(8)}`
    : `  ${"batch".padEnd(7)} ${"n".padStart(4)}  ${"median".padStart(10)}`;
  console.log(dim(header));

  for (let i = 0; i < benches.length; i++) {
    const bMed = percentile(benches[i], 0.5);
    const n = String(benches[i].length).padStart(4);
    const bStr = (timeMs(bMed) ?? "").padStart(10);

    if (baselines && baselines[i]) {
      const baseMed = percentile(baselines[i], 0.5);
      const baseStr = (timeMs(baseMed) ?? "").padStart(10);
      const delta = ((bMed - baseMed) / baseMed) * 100;
      const deltaStr = formatDelta(delta).padStart(8);
      const order = i % 2 === 0 ? dim(" B>C") : dim(" C>B");
      console.log(`  ${String(i).padEnd(7)} ${n}  ${bStr}  ${baseStr}  ${deltaStr}${order}`);
    } else {
      console.log(`  ${String(i).padEnd(7)} ${n}  ${bStr}`);
    }
  }
}

/** Analyze order effect: does running second make a difference? */
function printOrderEffect(
  benches: number[][],
  baselines: number[][],
): void {
  // Even batches: baseline runs first (B>C), odd: current runs first (C>B)
  const baseFirstDeltas: number[] = []; // even: baseline ran first
  const currFirstDeltas: number[] = []; // odd: current ran first

  for (let i = 0; i < benches.length; i++) {
    const bMed = percentile(benches[i], 0.5);
    const baseMed = percentile(baselines[i], 0.5);
    const delta = ((bMed - baseMed) / baseMed) * 100;
    if (i % 2 === 0) baseFirstDeltas.push(delta);
    else currFirstDeltas.push(delta);
  }

  const baseFirstAvg = baseFirstDeltas.length ? average(baseFirstDeltas) : 0;
  const currFirstAvg = currFirstDeltas.length ? average(currFirstDeltas) : 0;

  console.log();
  console.log(bold("  Order effect:"));
  console.log(
    `    baseline first (B>C): avg delta ${formatDelta(baseFirstAvg)}` +
      dim(` (${baseFirstDeltas.length} batches)`),
  );
  console.log(
    `    current first  (C>B): avg delta ${formatDelta(currFirstAvg)}` +
      dim(` (${currFirstDeltas.length} batches)`),
  );

  const diff = Math.abs(baseFirstAvg - currFirstAvg);
  if (diff > 2) {
    console.log(yellow(`    ==> ${diff.toFixed(1)}% order effect detected`));
  } else {
    console.log(dim(`    order effect: ${diff.toFixed(1)}% (small)`));
  }
}

/** Print paired batch deltas and their consistency. */
function printPairedDeltas(
  benches: number[][],
  baselines: number[][],
): void {
  const deltas = benches.map((b, i) => {
    const bMed = percentile(b, 0.5);
    const baseMed = percentile(baselines[i], 0.5);
    return ((bMed - baseMed) / baseMed) * 100;
  });

  const positive = deltas.filter(d => d > 0).length;
  const negative = deltas.filter(d => d < 0).length;
  const avgDelta = average(deltas);
  const med = percentile(deltas, 0.5);
  const spread = percentile(deltas, 0.75) - percentile(deltas, 0.25);

  console.log();
  console.log(bold("  Paired deltas:"));
  console.log(`    mean: ${formatDelta(avgDelta)}  median: ${formatDelta(med)}  IQR: ${spread.toFixed(1)}%`);
  console.log(
    `    direction: ${positive} slower, ${negative} faster` +
      dim(` (${deltas.length} batches)`),
  );

  if (positive > 0 && negative > 0) {
    console.log(green("    ==> batches disagree on direction"));
  } else {
    console.log(red("    ==> all batches agree on direction (systematic bias?)"));
  }
}

function formatDelta(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  const str = `${sign}${pct.toFixed(1)}%`;
  if (pct > 1) return red(str);
  if (pct < -1) return green(str);
  return str;
}

/** Diagnostic analysis of a .benchforge archive's per-batch statistics. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import colors from "../report/Colors.ts";
import {
  formatSignedPercent,
  percentMagnitude,
  timeMs,
} from "../report/Formatters.ts";
import { warmupDropped } from "../runners/MergeBatches.ts";
import { splitByOffsets, tukeyFences } from "../stats/BlockBootstrap.ts";
import { mean, median, percentile } from "../stats/CoreStats.ts";
import {
  batchMeanAutocorrelation,
  pairingBenefit,
  roundPairCorrelation,
  varianceInflation,
  withinBatchAutocorrelation,
} from "../stats/NoiseStructure.ts";
import type { BenchmarkEntry, BenchmarkGroup } from "../viewer/ReportData.ts";

const { bold, dim, red, green, yellow } = colors;

const blockFenceMultiplier = 3;

/** Autocorrelation magnitude above which a lag is flagged as correlated. */
const acfFlag = 0.2;

/** Read an archive and print per-batch diagnostic analysis (a benchforge
 *  development tool, not a general user tool). */
export async function analyzeArchive(filePath: string): Promise<void> {
  const content = await readFile(resolve(filePath), "utf-8");
  const { report } = JSON.parse(content);
  if (!report?.groups?.length) {
    console.error("No report data found in archive.");
    return;
  }
  const cliArgs = report.metadata?.cliArgs as
    | Record<string, unknown>
    | undefined;
  const batchCount = cliArgs?.batches as number | undefined;
  const firstRound = firstMergedRound(cliArgs, batchCount);
  for (const group of report.groups) {
    analyzeGroup(group, batchCount, firstRound);
  }
}

/** Batch context shared by {@link printNoiseStructure} and {@link printPairing}. */
interface BatchAnalysisContext {
  bench: BenchmarkEntry;
  baseline: BenchmarkEntry | undefined;
  benchOffsets: number[];
  baseOffsets: number[] | undefined;
  batches: number[][];
  baseBatches: number[][] | undefined;
  firstRound?: number;
}

/** A {@link BatchAnalysisContext} with the baseline fields narrowed to present,
 *  as guaranteed by {@link printNoiseStructure}'s pairing check. */
type PairedBatchContext = BatchAnalysisContext & {
  baseline: BenchmarkEntry;
  baseOffsets: number[];
  baseBatches: number[][];
};

/** Quantify how much block resampling and paired differencing actually buy on
 *  this data: within/cross-batch autocorrelation, variance inflation (block vs
 *  IID single-sample CI), and the paired-vs-unpaired delta CI ratio. */
function printNoiseStructure(ctx: BatchAnalysisContext): void {
  const { bench, baseline, benchOffsets, baseOffsets } = ctx;
  const { batches, baseBatches } = ctx;
  console.log();
  console.log(bold("  Noise structure:"));
  printAutocorr(batches);

  if (batches.length < 2) return;
  printVif(bench.samples, benchOffsets);

  if (baseline && baseOffsets && baseBatches?.length === batches.length)
    printPairing({ ...ctx, baseline, baseOffsets, baseBatches });
}

/** Paired-vs-unpaired delta CI ratio (trimmed and untrimmed) and the round-level
 *  baseline/current correlation that pairing exploits. */
function printPairing(ctx: PairedBatchContext): void {
  const { bench, baseline, benchOffsets, baseOffsets } = ctx;
  const { batches, baseBatches, firstRound = 0 } = ctx;
  const base = baseline.samples;
  const cur = bench.samples;
  const trimmed = pairingBenefit(base, baseOffsets, cur, benchOffsets, "mean");
  const untrimmed = pairingBenefit(
    base,
    baseOffsets,
    cur,
    benchOffsets,
    "mean",
    { noBatchTrim: true },
  );
  const widths = `paired ${percentMagnitude(trimmed.pairedWidth)} / unpaired ${percentMagnitude(trimmed.unpairedWidth)}, ${trimmed.rounds}/${untrimmed.rounds} rounds`;
  console.log(
    `    pairing (mean): ratio ${fmtRatio(trimmed.ratio)} trimmed / ${fmtRatio(untrimmed.ratio)} untrimmed` +
      dim(`   (${widths})`) +
      pairingVerdict(trimmed.ratio),
  );
  const corr = roundPairCorrelation(baseBatches, batches, firstRound);
  console.log(
    `    round corr: overall ${corr.overall.toFixed(2)}` +
      dim(
        `   (B-first ${corr.baselineFirst.toFixed(2)}, C-first ${corr.currentFirst.toFixed(2)})`,
      ),
  );
}

/** Within-batch (sample-lag) and cross-round (per-round-mean-lag) ACFs. */
function printAutocorr(batches: number[][]): void {
  const within = withinBatchAutocorrelation(batches);
  const cross = batchMeanAutocorrelation(batches);
  console.log(
    `    within-batch acf: ${fmtAcf(within)}` +
      acfVerdict(
        within,
        "within-batch correlation (blocking earns its keep)",
        "samples ~ independent",
      ),
  );
  console.log(
    `    cross-round  acf: ${fmtAcf(cross)}` +
      acfVerdict(cross, "multi-round drift", "no multi-round drift"),
  );
}

/** Block vs IID single-sample CI widths and their inflation factor. */
function printVif(samples: number[], offsets: number[]): void {
  const inflation = varianceInflation(samples, offsets, "mean");
  const widths = `block ${timeMs(inflation.blockWidth) ?? "?"} / iid ${timeMs(inflation.iidWidth) ?? "?"}`;
  console.log(
    `    VIF (mean): ${fmtRatio(inflation.vif)}` +
      dim(`   (${widths})`) +
      vifVerdict(inflation.vif),
  );
}

/** Format a CI-width ratio; "n/a" when non-finite (zero-variance samples). */
function fmtRatio(ratio: number): string {
  return Number.isFinite(ratio) ? ratio.toFixed(2) : "n/a";
}

/** Verdict for the paired-vs-unpaired delta CI width ratio. No verdict when
 *  the ratio is non-finite (zero-width unpaired CI). */
function pairingVerdict(ratio: number): string {
  if (!Number.isFinite(ratio)) return "";
  if (ratio < 0.9) return green("   ==> pairing sharpens the delta");
  if (ratio > 1.1) return red("   ==> pairing widens the delta (net cost)");
  return dim("   ==> pairing buys ~nothing");
}

/** Format an autocorrelation vector, or note when there were too few rounds. */
function fmtAcf(acf: number[]): string {
  if (!acf.length) return dim("(too few)");
  return acf.map(v => v.toFixed(2).padStart(6)).join(" ");
}

/** Flag autocorrelation when any of the first three lags exceeds the threshold.
 *  No verdict when there were too few rounds to estimate an ACF at all. */
function acfVerdict(
  acf: number[],
  correlated: string,
  independent: string,
): string {
  if (!acf.length) return "";
  const peak = Math.max(0, ...acf.slice(0, 3).map(Math.abs));
  return peak > acfFlag
    ? yellow(`   ==> ${correlated}`)
    : dim(`   ==> ${independent}`);
}

/** Verdict for the block-vs-IID variance inflation factor. Distance from 1 in
 *  either direction means blocking changes the CI: >1 wider (drift/autocorr),
 *  <1 tighter (structured within-batch variation that averages out per batch).
 *  No verdict when the ratio is non-finite (zero-width IID CI). */
function vifVerdict(vif: number): string {
  if (!Number.isFinite(vif)) return "";
  if (vif > 1.3)
    return yellow("   ==> blocking widens vs iid (drift/autocorrelation)");
  if (vif < 0.77)
    return yellow("   ==> blocking tightens vs iid (structured within-batch)");
  return dim("   ==> block ~ iid");
}

/** Original round index of merged batch 0. Round 0 is dropped as warmup by
 *  default (`runBatched`), which shifts batch parity -- and with it which
 *  batches ran baseline-first -- unless --warmup-batch kept it. */
function firstMergedRound(
  cliArgs: Record<string, unknown> | undefined,
  batchCount: number | undefined,
): number {
  const warmupKept = cliArgs?.["warmup-batch"] === true;
  const dropped =
    batchCount !== undefined && warmupDropped(batchCount, warmupKept);
  return dropped ? 1 : 0;
}

/** Print analysis for all benchmarks in a group. */
function analyzeGroup(
  group: BenchmarkGroup,
  batchCount?: number,
  firstRound = 0,
): void {
  console.log(bold(`\n=== ${group.name} ===\n`));

  for (const bench of group.benchmarks) {
    const baseline = bench.baseline ?? group.baseline;
    analyzeBenchmark(bench, baseline, batchCount, firstRound);
  }
}

/** Print per-batch analysis for one benchmark entry. */
function analyzeBenchmark(
  bench: BenchmarkEntry,
  baseline: BenchmarkEntry | undefined,
  batchCount?: number,
  firstRound = 0,
): void {
  // archives record offsets for merged batches: one fewer than requested
  // rounds when the warmup round was dropped
  const mergedCount =
    batchCount === undefined ? undefined : batchCount - firstRound;
  const benchOffsets =
    bench.batchOffsets ?? inferOffsets(bench.samples, mergedCount);
  const baseOffsets =
    baseline?.batchOffsets ?? inferOffsets(baseline?.samples, mergedCount);
  if (!benchOffsets?.length) {
    console.log(dim("  No batch data (single batch run)"));
    return;
  }

  const batches = splitByOffsets(bench.samples, benchOffsets);
  const baseBatches =
    baseOffsets && baseline
      ? splitByOffsets(baseline.samples, baseOffsets)
      : undefined;

  printBatchHeader(bench, baseline, batches.length);
  printBatchTable(batches, baseBatches, firstRound);

  if (baseBatches && baseBatches.length === batches.length) {
    printOrderEffect(batches, baseBatches, firstRound);
    printPairedDeltas(batches, baseBatches);
    printTrimmedBlocks(batches, baseBatches, bench.name);
  }
  printNoiseStructure({
    bench,
    baseline,
    benchOffsets,
    baseOffsets,
    batches,
    baseBatches,
    firstRound,
  });
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

/** Print benchmark name with batch/run summary. */
function printBatchHeader(
  bench: BenchmarkEntry,
  baseline: BenchmarkEntry | undefined,
  nBatches: number,
): void {
  const baseRuns = baseline?.samples?.length;
  const dur = bench.totalTime
    ? (bench.totalTime / nBatches).toFixed(1) + "s"
    : "?";
  const runs = baseRuns
    ? `${bench.samples.length}+${baseRuns} runs`
    : `${bench.samples.length} runs`;
  const info = dim(` (${nBatches} batches, ${runs}, ~${dur}/batch)`);
  console.log(bold(`  ${bench.name}`) + info);
}

/** Print per-batch median table for current and baseline. */
function printBatchTable(
  benches: number[][],
  baselines: number[][] | undefined,
  firstRound = 0,
): void {
  const header = baselines
    ? `  ${"batch".padEnd(7)} ${"n".padStart(4)}  ${"current".padStart(10)}  ${"baseline".padStart(10)}  ${"delta".padStart(8)}`
    : `  ${"batch".padEnd(7)} ${"n".padStart(4)}  ${"median".padStart(10)}`;
  console.log(dim(header));

  for (let i = 0; i < benches.length; i++) {
    const n = String(benches[i].length).padStart(4);
    const med = (timeMs(median(benches[i])) ?? "").padStart(10);
    const idx = String(i).padEnd(7);
    if (!baselines?.[i]) {
      console.log(`  ${idx} ${n}  ${med}`);
      continue;
    }
    const baseMed = (timeMs(median(baselines[i])) ?? "").padStart(10);
    const pct = medianDelta(benches[i], baselines[i]);
    const delta = formatDelta(pct).padStart(8);
    const order = (i + firstRound) % 2 === 0 ? dim(" B>C") : dim(" C>B");
    console.log(`  ${idx} ${n}  ${med}  ${baseMed}  ${delta}${order}`);
  }
}

/** Analyze order effect: does running second make a difference? */
function printOrderEffect(
  benches: number[][],
  baselines: number[][],
  firstRound = 0,
): void {
  // even original rounds run baseline first (B>C), odd run current first (C>B);
  // firstRound realigns merged batch indices to original round parity
  const deltas = benches.map((b, i) => medianDelta(b, baselines[i]));
  const baseFirstDeltas = deltas.filter((_, i) => (i + firstRound) % 2 === 0);
  const currFirstDeltas = deltas.filter((_, i) => (i + firstRound) % 2 === 1);
  const baseFirstAvg = baseFirstDeltas.length ? mean(baseFirstDeltas) : 0;
  const currFirstAvg = currFirstDeltas.length ? mean(currFirstDeltas) : 0;

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
function printPairedDeltas(benches: number[][], baselines: number[][]): void {
  const deltas = benches.map((b, i) => medianDelta(b, baselines[i]));

  const positive = deltas.filter(d => d > 0).length;
  const negative = deltas.filter(d => d < 0).length;
  const avgDelta = mean(deltas);
  const med = median(deltas);
  const spread = percentile(deltas, 0.75) - percentile(deltas, 0.25);

  console.log();
  console.log(bold("  Paired deltas:"));
  console.log(
    `    mean: ${formatDelta(avgDelta)}  median: ${formatDelta(med)}  IQR: ${spread.toFixed(1)}%`,
  );
  console.log(
    `    direction: ${positive} slower, ${negative} faster` +
      dim(` (${deltas.length} batches)`),
  );

  if (positive > 0 && negative > 0) {
    console.log(green("    ==> batches disagree on direction"));
  } else {
    console.log(
      red("    ==> all batches agree on direction (systematic bias?)"),
    );
  }
}

/** Show which blocks would be Tukey-trimmed per side. */
function printTrimmedBlocks(
  benches: number[][],
  baselines: number[][],
  name: string,
): void {
  console.log();
  console.log(bold("  Trimmed blocks:"));
  const baseMeans = baselines.map(b => mean(b));
  const benchMeans = benches.map(b => mean(b));
  printSideTrim("baseline", baseMeans);
  printSideTrim(name, benchMeans);
}

/** Percent delta between two medians. */
function medianDelta(samples: number[], baseSamples: number[]): number {
  const med = median(samples);
  const baseMed = median(baseSamples);
  return ((med - baseMed) / baseMed) * 100;
}

/** Color a percent delta: red if >1%, green if <-1%. */
function formatDelta(pct: number): string {
  const str = formatSignedPercent(pct);
  if (pct > 1) return red(str);
  if (pct < -1) return green(str);
  return str;
}

/** Print trimming info for one side using 3x IQR fences. */
function printSideTrim(label: string, means: number[]): void {
  const [, hi] = tukeyFences(means, blockFenceMultiplier);
  const indices = means.map((v, i) => (v > hi ? i : -1)).filter(i => i >= 0);
  if (indices.length === 0) {
    console.log(dim(`    ${label}: 0 trimmed`));
    return;
  }
  const vals = indices.map(i => timeMs(means[i]) ?? "?").join(", ");
  const fence = `hi: ${timeMs(hi)}`;
  console.log(
    `    ${label}: ${yellow(`${indices.length} trimmed`)} (${vals})` +
      dim(`  fence: ${fence}`),
  );
}

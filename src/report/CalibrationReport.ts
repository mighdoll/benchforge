import type { CalibrationResult } from "../runners/Calibration.ts";
import type { IntegerCount } from "../stats/CoreStats.ts";
import { formatCliCommand } from "./CliCommand.ts";
import { formatSignedPercent, percentMagnitude as pct } from "./Formatters.ts";
import { formatGitVersion, type GitVersion } from "./GitUtils.ts";
import { mdTable } from "./MarkdownTable.ts";

/** Header context for a saved calibration report. */
export interface CalibrationMeta {
  timestamp: string;
  cliArgs?: Record<string, unknown>;
  cliDefaults?: Record<string, unknown>;
  currentVersion?: GitVersion;
  environment?: { node: string; platform: string; arch: string };
}

/** One noise-floor warning, uncolored so the terminal and markdown formatters
 *  can present it their own way. `detail` may span several lines. */
export interface CalibrationWarning {
  summary: string;
  detail: string;
}

/** Below this many full GCs per batch, the batch mean is dominated by where the
 *  lone collection lands and single-run CIs understate between-run GC variance. */
const minFullGcsPerBatch = 2;

/** A run straddles a GC-count step when its modal batch count holds less than
 *  this share of batches: most batches do N full GCs, the rest do N+/-1, and
 *  the per-batch mean jumps by a whole major GC between them. Allows a few stray
 *  batches without warning, but flags a genuine split. */
const minModalShare = 0.9;

/** Render a calibration result as a self-contained markdown report: a header
 *  recalling the invocation and machine, the noise-floor summary (with the
 *  suggested margin), any warnings, and the per-run table. */
export function calibrationMarkdown(
  result: CalibrationResult,
  meta: CalibrationMeta,
): string {
  const parts = [
    header(meta),
    noiseFloor(result),
    ...calibrationWarnings(result).map(warningQuote),
    perRunTable(result),
  ];
  return parts.filter(Boolean).join("\n\n") + "\n";
}

/** Noise-floor warnings in display order: overconfidence first, then the GC
 *  floor or straddle (mutually exclusive, floor takes priority). */
export function calibrationWarnings(
  result: CalibrationResult,
): CalibrationWarning[] {
  const { summary: s, fullGcsPerBatch, gcHistogram } = result;
  const warnings: CalibrationWarning[] = [];
  if (s.overconfident) {
    warnings.push({
      summary: `scatter (${pct(s.scatterP95)}) exceeds within-run CI (${pct(s.meanCiHalfWidth)})`,
      detail:
        "per-run CIs are overconfident; displayed CIs understate run-to-run\n" +
        "noise. Margin taken from the scatter, not the CI.",
    });
  }
  if (fullGcsPerBatch !== undefined && fullGcsPerBatch < minFullGcsPerBatch) {
    warnings.push({
      summary: `only ${fullGcsPerBatch.toFixed(1)} full GCs per batch (want >= ${minFullGcsPerBatch})`,
      detail:
        "the batch mean depends on where the lone collection lands, so GC\n" +
        "timing varies between runs. Increase --duration.",
    });
  } else if (gcHistogram && straddlesStep(gcHistogram)) {
    warnings.push({
      summary: `full GCs/batch varies across batches (${formatGcHistogram(gcHistogram)})`,
      detail:
        "some batches do a major collection the others don't; the per-batch\n" +
        "mean jumps by a whole GC. Adjust --duration so every batch\n" +
        "lands on the same plateau.",
    });
  }
  return warnings;
}

/** Render a GC-per-batch histogram as a one-line tally, e.g. "2x97  3x3". */
export function formatGcHistogram(hist: IntegerCount[]): string {
  return hist.map(b => `${b.value}x${b.count}`).join("  ");
}

/** Title, invocation, git version, timestamp + machine. */
function header(meta: CalibrationMeta): string {
  const { cliArgs, cliDefaults, currentVersion, environment, timestamp } = meta;
  const lines = [
    "# Calibration report",
    `\`${formatCliCommand(cliArgs, cliDefaults)}\``,
    currentVersion ? `current \`${formatGitVersion(currentVersion)}\`` : "",
    environment
      ? `${timestamp} -- node ${environment.node}, ${environment.platform} ${environment.arch}`
      : timestamp,
  ];
  return lines.filter(Boolean).join("\n\n");
}

/** Noise-floor summary as a `| metric | value |` table; the suggested margin is
 *  the headline (bold), and the GC row appears only when GC stats were taken. */
function noiseFloor(result: CalibrationResult): string {
  const { runs, batches, summary: s, fullGcsPerBatch, gcHistogram } = result;
  const rows = [
    ["mean Δ%", `${formatSignedPercent(s.meanPoint)} (expected ~0)`],
    [
      "point-estimate scatter",
      `${pct(s.scatterStd)} std, ${pct(s.scatterP95)} 95th pct abs`,
    ],
    ["within-run CI half-width", `${pct(s.meanCiHalfWidth)} mean`],
    ["**suggested --equiv-margin**", `**${pct(s.suggestedMargin)}**`],
  ];
  if (gcHistogram && fullGcsPerBatch !== undefined) {
    rows.push([
      "full GCs/batch",
      `${formatGcHistogram(gcHistogram)} (mean ${fullGcsPerBatch.toFixed(1)})`,
    ]);
  }
  const title = `## Noise floor (${runs} runs x ${batches} batches, current vs current)`;
  return `${title}\n\n${mdTable(["metric", "value"], rows)}`;
}

/** A warning as a markdown blockquote, one `>` per line. */
function warningQuote(w: CalibrationWarning): string {
  const lines = [`**warning:** ${w.summary}`, ...w.detail.split("\n")];
  return lines.map(l => `> ${l}`).join("\n");
}

/** Per-run table of point estimate and CI half-width. */
function perRunTable(result: CalibrationResult): string {
  const { pointEstimates, ciHalfWidths } = result;
  const rows = pointEstimates.map((p, i) => [
    `${i + 1}`,
    formatSignedPercent(p),
    pct(ciHalfWidths[i]),
  ]);
  const table = mdTable(["run", "Δ%", "CI half-width"], rows);
  return `## Per-run\n\n${table}`;
}

/** True when the modal GC-count bucket holds less than minModalShare of all
 *  batches. A single bucket (one plateau) never straddles. */
function straddlesStep(hist: IntegerCount[]): boolean {
  if (hist.length < 2) return false;
  const total = hist.reduce((sum, b) => sum + b.count, 0);
  const modal = Math.max(...hist.map(b => b.count));
  return modal / total < minModalShare;
}

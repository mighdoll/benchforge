import colors from "../report/Colors.ts";
import { formatSignedPercent } from "../report/Formatters.ts";
import type { CalibrationResult, RunProgress } from "../runners/Calibration.ts";

/** Below this many full GCs per batch, the batch mean is dominated by where the
 *  lone collection lands and single-run CIs understate between-run GC variance. */
const minFullGcsPerBatch = 2;

/** Print one progress line per completed self-comparison run (to stderr). */
export function reportCalibrateRun(p: RunProgress, label?: string): void {
  const where = label ? ` ${label}` : "";
  const delta = formatSignedPercent(p.point).padStart(7);
  process.stderr.write(
    colors.dim(
      `  calibrate${where} run ${p.run}/${p.runs}: Δ ${delta}  CI ±${pct(p.ciHalfWidth).padStart(7)}\n`,
    ),
  );
}

/** Format the calibration result as a per-run table plus a conclusion block. */
export function formatCalibration(result: CalibrationResult): string {
  const { pointEstimates, ciHalfWidths } = result;
  const rows = pointEstimates.map((p, i) => {
    const run = String(i + 1).padStart(4);
    return `  ${run}  ${formatSignedPercent(p).padStart(8)}     ${pct(ciHalfWidths[i]).padStart(8)}`;
  });
  const table = ["   run        Δ%   CI half-width", ...rows].join("\n");
  return `${table}\n\n${conclusion(result)}`;
}

/** Format an unsigned percent magnitude, e.g. "1.85%". */
function pct(n: number): string {
  return `${n.toFixed(2)}%`;
}

/** A run straddles a GC-count step when its modal batch count holds less than
 *  this share of batches: most batches do N full GCs, the rest do N+/-1, and
 *  the per-batch mean jumps by a whole major GC between them. Allows a few stray
 *  batches without warning, but flags a genuine split. */
const minModalShare = 0.9;

/** Conclusion block: noise floor estimates and the suggested margin. */
function conclusion(result: CalibrationResult): string {
  const { runs, batches, summary: s, fullGcsPerBatch, gcHistogram } = result;
  const { bold, yellow } = colors;
  const lines = [
    bold(
      `noise-floor calibration (${runs} runs x ${batches} batches, current vs current)`,
    ),
    `  mean Δ%                  ${formatSignedPercent(s.meanPoint).padStart(7)}   (expected ~0)`,
    `  point-estimate scatter   ${pct(s.scatterStd).padStart(7)}   std,  ${pct(s.scatterP95)} 95th pct |Δ|`,
    `  within-run CI half-width ${pct(s.meanCiHalfWidth).padStart(7)}   mean`,
    bold(`  suggested --equiv-margin ${pct(s.suggestedMargin).padStart(7)}`),
  ];
  if (gcHistogram && fullGcsPerBatch !== undefined) {
    lines.push(
      `  full GCs/batch           ${formatGcHistogram(gcHistogram)}   (mean ${fullGcsPerBatch.toFixed(1)})`,
    );
  }
  if (s.overconfident) {
    lines.push(
      "",
      yellow(
        `  warning: scatter (${pct(s.scatterP95)}) exceeds within-run CI (${pct(s.meanCiHalfWidth)}) --`,
      ),
      yellow(
        "    per-run CIs are overconfident; displayed CIs understate run-to-run",
      ),
      yellow("    noise. Margin taken from the scatter, not the CI."),
    );
  }
  if (fullGcsPerBatch !== undefined && fullGcsPerBatch < minFullGcsPerBatch) {
    lines.push(
      "",
      yellow(
        `  warning: only ${fullGcsPerBatch.toFixed(1)} full GCs per batch (want >= ${minFullGcsPerBatch}) --`,
      ),
      yellow(
        "    the batch mean depends on where the lone collection lands, so GC",
      ),
      yellow("    timing varies between runs. Increase --duration."),
    );
  } else if (gcHistogram && straddlesStep(gcHistogram)) {
    lines.push(
      "",
      yellow(
        `  warning: full GCs/batch varies across batches (${formatGcHistogram(gcHistogram)}) --`,
      ),
      yellow(
        "    some batches do a major collection the others don't; the per-batch",
      ),
      yellow("    mean jumps by a whole GC. Adjust --duration so every batch"),
      yellow("    lands on the same plateau."),
    );
  }
  return lines.join("\n");
}

/** Render a GC-per-batch histogram as a one-line tally, e.g. "2x97  3x3". */
function formatGcHistogram(hist: { value: number; count: number }[]): string {
  return hist.map(b => `${b.value}x${b.count}`).join("  ");
}

/** True when batches don't share one GC plateau: the modal bucket holds less
 *  than minModalShare of all batches, so a meaningful fraction do a different
 *  number of full GCs. A single plateau (one bucket) never straddles. */
function straddlesStep(hist: { value: number; count: number }[]): boolean {
  if (hist.length < 2) return false;
  const total = hist.reduce((sum, b) => sum + b.count, 0);
  const modal = Math.max(...hist.map(b => b.count));
  return modal / total < minModalShare;
}

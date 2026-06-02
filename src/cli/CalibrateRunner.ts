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

/** Conclusion block: noise floor estimates and the suggested margin. */
function conclusion(result: CalibrationResult): string {
  const { runs, batches, summary: s, fullGcsPerBatch } = result;
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
  }
  return lines.join("\n");
}

import {
  calibrationWarnings,
  formatGcHistogram,
} from "../report/CalibrationReport.ts";
import colors from "../report/Colors.ts";
import {
  formatSignedPercent,
  percentMagnitude as pct,
} from "../report/Formatters.ts";
import type { CalibrationResult, RunProgress } from "../runners/Calibration.ts";

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
  for (const w of calibrationWarnings(result)) {
    lines.push("", yellow(`  warning: ${w.summary} --`));
    for (const line of w.detail.split("\n")) lines.push(yellow(`    ${line}`));
  }
  return lines.join("\n");
}

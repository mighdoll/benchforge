import colors from "../report/Colors.ts";
import { formatSignedPercent } from "../report/Formatters.ts";
import type { CalibrationResult, RunProgress } from "../runners/Calibration.ts";
import type { CalibrationSummary } from "../stats/CalibrationSummary.ts";

/** Print one progress line per completed self-comparison run (to stderr). */
export function reportCalibrateRun(p: RunProgress, label?: string): void {
  const { dim } = colors;
  const where = label ? ` ${label}` : "";
  const pt = formatSignedPercent(p.point).padStart(7);
  const hw = `${p.ciHalfWidth.toFixed(2)}%`.padStart(7);
  process.stderr.write(
    dim(`  calibrate${where} run ${p.run}/${p.runs}: Δ ${pt}  CI ±${hw}\n`),
  );
}

/** Format the calibration result as a per-run table plus a conclusion block. */
export function formatCalibration(result: CalibrationResult): string {
  const { runs, batches, pointEstimates, ciHalfWidths, summary } = result;
  const rows = pointEstimates.map((p, i) => {
    const run = String(i + 1).padStart(4);
    const dPct = formatSignedPercent(p).padStart(8);
    const hw = `${ciHalfWidths[i].toFixed(2)}%`.padStart(8);
    return `  ${run}  ${dPct}     ${hw}`;
  });
  const table = ["   run        Δ%   CI half-width", ...rows].join("\n");
  return `${table}\n\n${conclusion(runs, batches, summary)}`;
}

/** Conclusion block: noise floor estimates and the suggested margin. */
function conclusion(
  runs: number,
  batches: number,
  s: CalibrationSummary,
): string {
  const { bold, yellow } = colors;
  const pct = (n: number) => `${n.toFixed(2)}%`;
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
  return lines.join("\n");
}

import { useEffect } from "preact/hooks";
import { formatSignedPercent } from "../../report/Formatters.ts";
import { verdictWord } from "../../report/Verdict.ts";
import type { DifferenceCI } from "../../stats/Bootstrap.ts";
import type { BootstrapCIData, ShiftPercentile } from "../ReportData.ts";
import { shiftDetail } from "../State.ts";
import { ciDomain, distributionOpts } from "./CIWidgets.tsx";
import { useLazyPlot } from "./LazyPlot.ts";

/** The single shared shift-detail popup, opened from any CI chart or violin. */
export function ShiftDetailPopup() {
  const detail = shiftDetail.value;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") shiftDetail.value = null;
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!detail) return null;
  return (
    <ShiftPopup
      point={detail.point}
      metric={detail.metric}
      equivMargin={detail.equivMargin}
      onClose={() => (shiftDetail.value = null)}
    />
  );
}

/** Modal detailing one percentile: the diff CI chart, then each run's absolute
 *  distribution. */
function ShiftPopup({ point, metric, equivMargin, onClose }: {
  point: ShiftPercentile;
  metric: string;
  equivMargin?: number;
  onClose: () => void;
}) {
  const { diff } = point;
  // Shared x-domain so the per-run absolute charts use one scale: equal pixel
  // positions mean equal values, making medians and CIs comparable across runs.
  const domain = ciDomain(point.runs.map(r => r.bootstrapCI));
  return (
    <div class="shift-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div class="shift-popup">
        <span class="shift-close" onClick={onClose}>{"×"}</span>
        <div class="shift-popup-head">
          <h3>{metric} &middot; {point.label}</h3>
          <ShiftVerdict point={point} />
        </div>
        <div class="shift-charts">
          <ShiftPopupDiff ci={diff} equivMargin={equivMargin} />
          {point.runs.map((run, i) => (
            <ShiftPopupAbsolute key={i} runName={run.runName} ci={run.bootstrapCI} domain={domain} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Popup-title verdict chip. Unreliable percentiles report insufficient data
 *  instead of a verdict (the direction is untrustworthy with too few samples). */
function ShiftVerdict({ point }: { point: ShiftPercentile }) {
  if (!point.reliable)
    return (
      <span class="badge badge-insufficient">Insufficient data &middot; n={point.tailCount}</span>
    );
  const { direction, percent } = point.diff;
  return (
    <span class="shift-verdict">
      <span class={`badge badge-${direction}`}>{cap(verdictWord(direction))}</span>
      <span class="shift-verdict-pct">{formatSignedPercent(percent)}</span>
    </span>
  );
}

/** Capitalize the first letter (verdict words are lowercase). */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The diff CI chart in the popup (reuses createCIPlot). The Δ% point estimate
 *  is drawn as a bold label above the median line, not in the popup title. */
function ShiftPopupDiff({ ci, equivMargin }: { ci: DifferenceCI; equivMargin?: number }) {
  const ref = useLazyPlot(async () => {
    const { createCIPlot } = await import("../plots/CIPlot.ts");
    const opts = { width: 320, height: 90, title: "", pointLabel: formatSignedPercent(ci.percent), equivMargin };
    return createCIPlot(ci, opts);
  }, [ci], "Shift diff plot");
  return (
    <div class="shift-chart">
      <div class="shift-chart-label">difference</div>
      <div ref={ref} />
    </div>
  );
}

/** One run's absolute distribution in the popup (reuses createDistributionPlot).
 *  `domain` shares the x-scale across runs so positions are comparable. */
function ShiftPopupAbsolute(
  { runName, ci, domain }:
  { runName: string; ci: BootstrapCIData; domain?: [number, number] },
) {
  const ref = useLazyPlot(async () => {
    const { createDistributionPlot } = await import("../plots/CIPlot.ts");
    const opts = distributionOpts(ci, {
      width: 320, height: 90, pointLabel: ci.estimateLabel, domain,
    });
    return createDistributionPlot(ci.histogram, ci.ci, ci.estimate, opts);
  }, [ci, domain], "Shift absolute plot");
  return (
    <div class="shift-chart">
      <div class="shift-chart-label">{runName}</div>
      <div ref={ref} />
    </div>
  );
}

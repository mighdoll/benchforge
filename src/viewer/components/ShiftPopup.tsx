import { formatSignedPercent } from "../../report/Formatters.ts";
import { verdictWord } from "../../report/Verdict.ts";
import type { DifferenceCI } from "../../stats/Bootstrap.ts";
import type {
  AbsolutePercentile,
  BootstrapCIData,
  ShiftPercentile,
} from "../ReportData.ts";
import { absoluteDetail, shiftDetail, useEscapeClose } from "../State.ts";
import { ciDomain, distributionOpts } from "./CIWidgets.tsx";
import { useLazyPlot } from "./LazyPlot.ts";

/** The single shared shift-detail popup, opened from any CI chart or violin. */
export function ShiftDetailPopup() {
  const detail = shiftDetail.value;
  useEscapeClose(() => (shiftDetail.value = null));
  if (!detail) return null;
  return (
    <ShiftPopup
      point={detail.point}
      metric={detail.metric}
      marginBand={detail.marginBand}
      onClose={() => (shiftDetail.value = null)}
    />
  );
}

/** The single shared absolute-distribution detail popup, opened from a
 *  no-baseline fan's violin. */
export function AbsoluteDetailPopup() {
  const detail = absoluteDetail.value;
  useEscapeClose(() => (absoluteDetail.value = null));
  if (!detail) return null;
  return (
    <AbsolutePopup
      point={detail.point}
      metric={detail.metric}
      onClose={() => (absoluteDetail.value = null)}
    />
  );
}

/** Modal detailing one percentile: the diff CI chart, then each run's absolute
 *  distribution. */
function ShiftPopup({ point, metric, marginBand, onClose }: {
  point: ShiftPercentile;
  metric: string;
  marginBand?: [number, number];
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
          <ShiftPopupDiff ci={diff} marginBand={marginBand} />
          {point.runs.map((run, i) => (
            <ShiftPopupAbsolute key={i} runName={run.runName} ci={run.bootstrapCI} domain={domain} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Modal detailing one percentile's absolute distribution on its own scale,
 *  where a tight CI the fan crushes against the full-range axis is legible. */
function AbsolutePopup({ point, metric, onClose }: {
  point: AbsolutePercentile;
  metric: string;
  onClose: () => void;
}) {
  return (
    <div class="shift-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div class="shift-popup">
        <span class="shift-close" onClick={onClose}>{"×"}</span>
        <div class="shift-popup-head">
          <h3>{metric} &middot; {point.label}</h3>
          {point.reliable
            ? <span class="shift-verdict-pct">{point.ci.estimateLabel}</span>
            : <span class="badge badge-insufficient">Insufficient data &middot; n={point.tailCount}</span>}
        </div>
        <div class="shift-charts">
          <ShiftPopupAbsolute runName={metric} ci={point.ci} />
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

/** The diff CI chart in the popup (reuses createCIPlot). The Δ% point estimate
 *  is drawn as a bold label above the median line, not in the popup title. */
function ShiftPopupDiff({ ci, marginBand }: { ci: DifferenceCI; marginBand?: [number, number] }) {
  const ref = useLazyPlot(async () => {
    const { createCIPlot } = await import("../plots/CIPlot.ts");
    const opts = { width: 320, height: 90, title: "", pointLabel: formatSignedPercent(ci.percent), marginBand };
    return createCIPlot(ci, opts);
  }, [ci, marginBand?.[0], marginBand?.[1]], "Shift diff plot");
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

/** Capitalize the first letter (verdict words are lowercase). */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

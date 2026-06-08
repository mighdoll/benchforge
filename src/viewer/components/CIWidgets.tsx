import type { CIDirection, DifferenceCI } from "../../stats/StatisticalUtils.ts";
import type {
  BootstrapCIData,
  ShiftFunction,
  ShiftPercentile,
} from "../ReportData.ts";
import { formatPct } from "../plots/PlotTypes.ts";
import { reportData, shiftDetail } from "../State.ts";
import { useLazyPlot } from "./LazyPlot.ts";

/** Proportional horizontal offset range for aligning bootstrap CI plots. */
export const maxCIShift = 80;

const directionLabels: Record<CIDirection, string> = {
  faster: "Faster",
  slower: "Slower",
  uncertain: "Inconclusive",
  equivalent: "Equivalent",
};

/** Open the shared detail popup for one point of a shift function. */
export function openShiftDetail(shift: ShiftFunction, point: ShiftPercentile) {
  shiftDetail.value = {
    point,
    metric: shift.metric,
    equivMargin: shift.equivMargin,
  };
}

/** A thunk opening the popup for a shift function's verdict point, or undefined
 *  when there's no usable target (the CI chart then stays non-interactive). */
export function shiftDetailOpener(
  shift?: ShiftFunction,
): (() => void) | undefined {
  if (!shift) return undefined;
  const point = verdictPoint(shift);
  if (!point) return undefined;
  return () => openShiftDetail(shift, point);
}

/** Verdict point of a shift function: the selected verdict stat, else the mean,
 *  else the first point. Drives the CI-chart click target. */
export function verdictPoint(shift: ShiftFunction): ShiftPercentile | undefined {
  return (
    shift.points.find(p => p.isPrimary) ??
    shift.points.find(p => p.isMean) ??
    shift.points[0]
  );
}

/** Min/max x across a set of bootstrap distributions (histogram bins + CI
 *  bounds), for a shared scale across tracks/runs. */
export function ciDomain(cis: BootstrapCIData[]): [number, number] | undefined {
  const xs = cis.flatMap(ci => [...ci.histogram.map(b => b.x), ...ci.ci]);
  if (xs.length < 2) return undefined;
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  return max > min ? [min, max] : undefined;
}

/** Comparison verdict: a colored chip (group header) or plain delta text
 *  (compact). When `onOpen` is set, the CI chart becomes a click target. */
export function ComparisonBadge(
  { ci, compact, onOpen }:
  { ci: DifferenceCI; compact?: boolean; onOpen?: () => void },
) {
  // Colored chip is reserved for the main verdict; per-row (compact) comparisons
  // render as plain bold text regardless of direction.
  const cls = compact ? "comparison-plain" : `badge badge-${ci.direction}`;
  return (
    <span class="comparison-badge">
      <span class={cls}>
        {compact ? formatPct(ci.percent) : directionLabels[ci.direction]}
      </span>
      {ci.histogram && <CIPlotMount ci={ci} compact={compact} onOpen={onOpen} />}
    </span>
  );
}

/** Lazy-imports CIPlot and renders a confidence interval chart inline. When
 *  `onOpen` is set the chart is clickable; the click is stopped from bubbling so
 *  it doesn't also toggle the enclosing group's collapse. */
function CIPlotMount(
  { ci, compact, onOpen }:
  { ci: DifferenceCI; compact?: boolean; onOpen?: () => void },
) {
  const ref = useLazyPlot(async () => {
    const { createCIPlot } = await import("../plots/CIPlot.ts");
    const equivMargin =
      (reportData.value?.metadata.cliArgs?.["equiv-margin"] as number) ||
      undefined;
    const opts = compact
      ? { width: 200, height: 70, title: "", equivMargin }
      : { equivMargin };
    return createCIPlot(ci, opts);
  }, [ci, compact], "CI plot");
  const clickable = !!onOpen;
  return (
    <div
      class={`ci-plot-container${clickable ? " ci-clickable" : ""}`}
      ref={ref}
      title={clickable ? "click for current vs baseline detail" : undefined}
      onClick={onOpen ? (e => { e.stopPropagation(); onOpen(); }) : undefined}
    />
  );
}

/** Lazy-imports CIPlot and renders a bootstrap distribution sparkline inline.
 *  `shift` nudges it horizontally to position the estimate within a section's
 *  range; `domain` pins a shared x-scale so sibling sparklines are comparable. */
export function BootstrapCIMount({ ci, label, shift, domain }: {
  ci: BootstrapCIData;
  label?: string;
  shift?: number;
  domain?: [number, number];
}) {
  const ref = useLazyPlot(async () => {
    const { createDistributionPlot } = await import("../plots/CIPlot.ts");
    const opts = {
      width: 240, height: 80, title: "", direction: "uncertain" as const,
      ciLabels: ci.ciLabels, includeZero: false, smooth: true, pointLabel: label,
      ciLevel: ci.ciLevel, ciReliable: ci.ciReliable, domain,
    };
    return createDistributionPlot(ci.histogram, ci.ci, ci.estimate, opts);
  }, [ci, label, domain], "Bootstrap CI plot");
  const style = shift != null ? { marginLeft: `${Math.round(shift)}px` } : undefined;
  return <div class="ci-plot-inline" style={style} ref={ref} />;
}

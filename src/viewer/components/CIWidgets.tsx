import { marginArg } from "../../report/CiFormatting.ts";
import { formatSignedPercent } from "../../report/Formatters.ts";
import { verdictLabel } from "../../report/Verdict.ts";
import type { DifferenceCI } from "../../stats/Bootstrap.ts";
import type { DistributionPlotOptions } from "../plots/CIPlot.ts";
import {
  type AbsolutePercentile,
  type AbsoluteShift,
  type BootstrapCIData,
  type ShiftFunction,
  type ShiftPercentile,
  shiftMarginBand,
  type ViewerEntry,
} from "../ReportData.ts";
import { absoluteDetail, reportData, shiftDetail } from "../State.ts";
import { HelpButton } from "./HelpButton.tsx";
import { useLazyPlot } from "./LazyPlot.ts";

/** Proportional horizontal offset range for aligning bootstrap CI plots. */
export const maxCIShift = 80;

/** Open the shared detail popup for one point of a shift function. */
export function openShiftDetail(shift: ShiftFunction, point: ShiftPercentile) {
  shiftDetail.value = {
    point,
    metric: shift.metric,
    marginBand: shiftMarginBand(shift),
  };
}

/** Open the detail popup for one percentile of an absolute (no-baseline) fan. */
export function openAbsoluteDetail(
  shift: AbsoluteShift,
  point: AbsolutePercentile,
) {
  absoluteDetail.value = {
    metric: shift.metric,
    label: point.label,
    runName: shift.metric,
    ci: point.ci,
    reliable: point.reliable,
    tailCount: point.tailCount,
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

/** The click action for one metric sparkline row: the current-vs-baseline modal
 *  for a comparison track (or a version-mode baseline paired to one), else a
 *  plain distribution detail for a peer-mode baseline. Undefined leaves the cell
 *  inert (no shift and no CI to show).
 *
 *  `entries` are the row's sibling tracks (to resolve a baseline's paired
 *  comparison); `metric`/`stat` label the distribution popup's title. */
export function sparklineAction(
  entry: ViewerEntry,
  entries: ViewerEntry[],
  metric: string,
  stat?: string,
): { open: () => void; title: string } | undefined {
  const comparisonTitle = "click for current vs baseline detail";
  const own = shiftDetailOpener(entry.shiftFunction);
  if (own) return { open: own, title: comparisonTitle };
  if (entry.isBaseline && entry.pairedRun) {
    const paired = shiftDetailOpener(
      entries.find(e => e.runName === entry.pairedRun)?.shiftFunction,
    );
    if (paired) return { open: paired, title: comparisonTitle };
  }
  const dist = distributionOpener(entry, metric, stat);
  return dist
    ? { open: dist, title: "click for distribution detail" }
    : undefined;
}

/** A thunk opening the distribution-detail popup for one track's own bootstrap
 *  distribution, or undefined when it has no CI to show. */
export function distributionOpener(
  entry: ViewerEntry,
  metric: string,
  stat?: string,
): (() => void) | undefined {
  const ci = entry.bootstrapCI;
  if (!ci) return undefined;
  return () => {
    absoluteDetail.value = { metric, label: stat, runName: entry.runName, ci };
  };
}

/** Verdict point of a shift function: the selected verdict stat, else the mean,
 *  else the first point. Drives the CI-chart click target. */
export function verdictPoint(
  shift: ShiftFunction,
): ShiftPercentile | undefined {
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
 *  (compact). When `onOpen` is set, the CI chart becomes a click target.
 *  `help` adds "?" popovers for the pill and for the chart. */
export function ComparisonBadge({
  ci,
  compact,
  onOpen,
  help,
  marginBand,
}: {
  ci: DifferenceCI;
  compact?: boolean;
  onOpen?: () => void;
  help?: boolean;
  marginBand?: [number, number];
}) {
  // Colored chip is reserved for the main verdict; per-row (compact) comparisons
  // render as plain bold text regardless of direction.
  const cls = compact ? "comparison-plain" : `badge badge-${ci.direction}`;
  return (
    <span class="comparison-badge">
      <span class={cls}>
        {compact ? formatSignedPercent(ci.percent) : verdictLabel(ci.direction)}
      </span>
      {help && <HelpButton topic="verdict" />}
      {ci.histogram && (
        <CIPlotMount
          ci={ci}
          compact={compact}
          onOpen={onOpen}
          marginBand={marginBand}
        />
      )}
      {!compact && (
        <span class="comparison-pct">{formatSignedPercent(ci.percent)}</span>
      )}
      {help && ci.histogram && <HelpButton topic="verdictChart" />}
    </span>
  );
}

/** DistributionPlotOptions for an absolute (non-zero-anchored) bootstrap plot,
 *  pulling CI labels/level/reliability off the data. Used by inline sparklines
 *  and the shift-detail popup, which differ only in size and point label. */
export function distributionOpts(
  ci: BootstrapCIData,
  size: {
    width: number;
    height: number;
    pointLabel?: string;
    domain?: [number, number];
  },
): DistributionPlotOptions {
  return {
    width: size.width,
    height: size.height,
    title: "",
    direction: "uncertain",
    ciLabels: ci.ciLabels,
    includeZero: false,
    smooth: true,
    pointLabel: size.pointLabel,
    ciLevel: ci.ciLevel,
    ciReliable: ci.ciReliable,
    domain: size.domain,
  };
}

/** Lazy-imports CIPlot and renders a bootstrap distribution sparkline inline.
 *  `shift` nudges it horizontally to position the estimate within a section's
 *  range; `domain` pins a shared x-scale so sibling sparklines are comparable. */
export function BootstrapCIMount({
  ci,
  label,
  shift,
  domain,
}: {
  ci: BootstrapCIData;
  label?: string;
  shift?: number;
  domain?: [number, number];
}) {
  const ref = useLazyPlot(
    async () => {
      const { createDistributionPlot } = await import("../plots/CIPlot.ts");
      const opts = distributionOpts(ci, {
        width: 240,
        height: 80,
        pointLabel: label,
        domain,
      });
      return createDistributionPlot(ci.histogram, ci.ci, ci.estimate, opts);
    },
    // Depend on domain's scalar ends, not the tuple: callers may pass a fresh
    // array each render, so a reference dep would re-run the plot every time.
    [ci, label, domain?.[0], domain?.[1]],
    "Bootstrap CI plot",
  );
  const style =
    shift != null ? { marginLeft: `${Math.round(shift)}px` } : undefined;
  return <div class="ci-plot-inline" style={style} ref={ref} />;
}

/** Lazy-imports CIPlot and renders a confidence interval chart inline. When
 *  `onOpen` is set the chart is clickable; the click is stopped from bubbling
 *  so enclosing click targets don't also fire. */
function CIPlotMount({
  ci,
  compact,
  onOpen,
  marginBand,
}: {
  ci: DifferenceCI;
  compact?: boolean;
  onOpen?: () => void;
  marginBand?: [number, number];
}) {
  const band = marginBand ?? cliArgsMarginBand();
  // Depend on band's scalar ends, not the tuple: the fallback builds a fresh
  // array each render, so a reference dep would re-run the plot every time.
  const ref = useLazyPlot(
    async () => {
      const { createCIPlot } = await import("../plots/CIPlot.ts");
      const opts = compact
        ? { width: 200, height: 70, title: "", marginBand: band }
        : { marginBand: band };
      return createCIPlot(ci, opts);
    },
    [ci, compact, band?.[0], band?.[1]],
    "CI plot",
  );
  const clickable = !!onOpen;
  return (
    <div
      class={`ci-plot-container${clickable ? " ci-clickable" : ""}`}
      ref={ref}
      title={clickable ? "click for current vs baseline detail" : undefined}
      onClick={
        onOpen
          ? e => {
              e.stopPropagation();
              onOpen();
            }
          : undefined
      }
    />
  );
}

/** Symmetric +/- band from the run's equiv-margin CLI arg, for archives that
 *  predate the serialized display band (no shift.equivMarginBand available). */
function cliArgsMarginBand(): [number, number] | undefined {
  const m = marginArg(reportData.value?.metadata.cliArgs);
  return m === undefined ? undefined : [-m, m];
}

import * as Plot from "@observablehq/plot";
import type { PlotContext, SampleData } from "./TimeSeriesMarks.ts";
import { defaultSeriesColor, seriesColorMap } from "./TimeSeriesSeries.ts";

type Downsample = <T>(
  data: T[],
  n: number,
  getX: (d: T) => number,
  getY: (d: T) => number,
) => T[];

/** Sample cap per dot-partition (warmup/baseline/measured) before downsampling
 *  kicks in; shared with SamplesPanel.tsx so its "(downsampled)" caption can't
 *  drift from what this plot actually thins. */
export const maxDots = 1000;

/** Dot marks for all sample categories: warmup, baseline, measured, rejected.
 *  In batchMode (the batch-aligned "All" view) per-point tooltips are dropped:
 *  hovering thousands of interleaved dots is more distracting than useful. */
export function sampleDotMarks(
  ctx: PlotContext,
  showRejected: boolean,
  lttb: Downsample,
  batchMode = false,
): any[] {
  const { unitSuffix, formatValue } = ctx;
  const fmtVal = (d: SampleData) =>
    `${formatValue(d.displayValue)}${unitSuffix}`;
  const tip = (fn: (d: SampleData) => string) => (batchMode ? undefined : fn);
  const tipTitle = tip(d => `Iteration ${d.sample}: ${fmtVal(d)}`);
  const xy = { x: "sample" as const, y: "displayValue" as const, r: 3 };
  const { warmup, baseline, measured, rejected } = partitionSamples(
    ctx.convertedData,
    showRejected,
    lttb,
  );
  const colors = seriesColorMap(ctx.allBenchmarks, ctx.baselineNames);
  const colorOf = (d: SampleData) =>
    colors.get(d.benchmark) ?? defaultSeriesColor;
  return [
    Plot.dot(warmup, {
      ...xy,
      stroke: "#dc3545",
      fill: "none",
      strokeWidth: 1.5,
      opacity: 0.7,
      title: tip(d => `Warmup ${d.sample}: ${fmtVal(d)}`),
    }),
    // baselines: series color outline (hollow) to distinguish from current dots
    Plot.dot(baseline, {
      ...xy,
      stroke: colorOf,
      fill: "none",
      strokeWidth: 2,
      opacity: 0.8,
      title: tipTitle,
    }),
    Plot.dot(measured, {
      ...xy,
      opacity: 0.8,
      title: tipTitle,
      fill: colorOf,
    }),
    ...rejectedDotMark(
      rejected,
      xy,
      tip(d => `Rejected iteration ${d.sample}: ${fmtVal(d)}`),
    ),
  ];
}

/** Split samples into warmup/baseline/measured/rejected and downsample each */
function partitionSamples(
  data: SampleData[],
  showRejected: boolean,
  lttb: Downsample,
) {
  const downsample = (arr: SampleData[]) =>
    lttb(
      arr,
      maxDots,
      d => d.sample,
      d => d.displayValue,
    );
  const active = data.filter(d => !d.isWarmup && !d.isRejected);
  const warmup = downsample(data.filter(d => d.isWarmup));
  const baseline = downsample(active.filter(d => d.isBaseline));
  const measured = downsample(active.filter(d => !d.isBaseline));
  const rejected = showRejected
    ? data.filter(d => d.isRejected && !d.isWarmup)
    : [];
  return { warmup, baseline, measured, rejected };
}

/** Semi-transparent hollow dots for Tukey-rejected outlier samples */
function rejectedDotMark(
  rejected: SampleData[],
  xy: { x: "sample"; y: "displayValue"; r: number },
  title: ((d: SampleData) => string) | undefined,
): any[] {
  if (!rejected.length) return [];
  return [
    Plot.dot(rejected, {
      ...xy,
      stroke: "#999",
      fill: "none",
      strokeWidth: 1,
      opacity: 0.3,
      title,
    }),
  ];
}

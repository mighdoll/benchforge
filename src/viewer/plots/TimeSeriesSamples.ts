import * as Plot from "@observablehq/plot";
import type { PlotContext, SampleData } from "./TimeSeriesMarks.ts";
import { defaultSeriesColor, seriesColorMap } from "./TimeSeriesSeries.ts";

type Downsample = <T>(
  data: T[],
  n: number,
  getX: (d: T) => number,
  getY: (d: T) => number,
) => T[];

const maxDots = 1000;

/** Dot marks for all sample categories: warmup, baseline, measured, rejected */
export function sampleDotMarks(
  ctx: PlotContext,
  showRejected: boolean,
  lttb: Downsample,
): any[] {
  const { unitSuffix, formatValue } = ctx;
  const fmtVal = (d: SampleData) =>
    `${formatValue(d.displayValue)}${unitSuffix}`;
  const tipTitle = (d: SampleData) => `Iteration ${d.sample}: ${fmtVal(d)}`;
  const xy = { x: "sample" as const, y: "displayValue" as const, r: 3 };
  const { warmup, baseline, measured, rejected } = partitionSamples(
    ctx.convertedData,
    showRejected,
    lttb,
  );
  const colors = seriesColorMap(ctx.benchmarks, ctx.baselineNames);
  const colorOf = (d: SampleData) =>
    colors.get(d.benchmark) ?? defaultSeriesColor;
  return [
    Plot.dot(warmup, {
      ...xy,
      stroke: "#dc3545",
      fill: "none",
      strokeWidth: 1.5,
      opacity: 0.7,
      title: (d: SampleData) => `Warmup ${d.sample}: ${fmtVal(d)}`,
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
    ...rejectedDotMark(rejected, xy, tipTitle),
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
  tipTitle: (d: SampleData) => string,
): any[] {
  if (!rejected.length) return [];
  return [
    Plot.dot(rejected, {
      ...xy,
      stroke: "#999",
      fill: "none",
      strokeWidth: 1,
      opacity: 0.3,
      title: (d: SampleData) => `Rejected ${tipTitle(d)}`,
    }),
  ];
}

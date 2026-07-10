import type { LegendItem } from "./LegendUtils.ts";
import { seriesColor } from "./PlotTypes.ts";

interface LegendParams {
  hasWarmup: boolean;
  gcSeries: string[];

  /** every series with full-GC events, shown or not, so a series' GC label
   *  matches its toggle pill regardless of which pills are on */
  allGcSeries: string[];

  pauseCount: number;
  hasHeap: boolean;
  hasBaselineHeap: boolean;
  hasRejected: boolean;
  benchmarks: string[];

  /** every series, visible or not, so colors stay stable across toggles */
  allBenchmarks: string[];

  baselineNames: Set<string>;
}

/** Fallback swatch for a series name absent from the color map (steel blue). */
export const defaultSeriesColor = "#4682b4";

/** Distinct color per benchmark series, keyed by name (Observable 10 palette,
 *  shared by the dots, the legend, and the toggle pills so swatches match).
 *  Baselines are sorted last so current benchmarks take the leading colors. */
export function seriesColorMap(
  benchmarks: string[],
  baselineNames: Set<string>,
): Map<string, string> {
  const ordered = orderSeries(benchmarks, baselineNames);
  return new Map(ordered.map((name, i) => [name, seriesColor(i)]));
}

/** Build legend items based on which data series are present in the plot */
export function buildLegendItems(p: LegendParams): LegendItem[] {
  const { hasWarmup, gcSeries, allGcSeries, pauseCount } = p;
  const { hasHeap, hasBaselineHeap } = p;
  const { hasRejected, benchmarks, allBenchmarks, baselineNames } = p;
  const colors = seriesColorMap(allBenchmarks, baselineNames);
  const items: LegendItem[] = [];
  if (hasWarmup)
    items.push({ color: "#dc3545", label: "warmup", style: "hollow-dot" });
  items.push(...seriesLegendItems(benchmarks, baselineNames, colors));
  if (hasRejected)
    items.push({ color: "#999", label: "rejected", style: "hollow-dot" });
  if (hasHeap) items.push({ color: "#93c5fd", label: "heap", style: "rect" });
  if (hasBaselineHeap)
    items.push({ color: "#fcd34d", label: "heap (baseline)", style: "rect" });
  if (pauseCount > 0)
    items.push({
      color: "#888",
      label: `pause (${pauseCount})`,
      style: "vertical-line",
      strokeDash: "4,4",
    });
  items.push(...gcLegendItems(gcSeries, allGcSeries, baselineNames, colors));
  return items;
}

/** Display label for a GC toggle or legend entry: "full GC" for a lone current
 *  variant, "full GC (baseline)" for the baseline, "full GC (name)" when several
 *  current variants each have GC marks and need disambiguating. */
export function gcSeriesLabel(
  name: string,
  isBaseline: boolean,
  multiCurrent: boolean,
): string {
  if (isBaseline) return "full GC (baseline)";
  if (multiCurrent) return `full GC (${name})`;
  return "full GC";
}

/** Current benchmarks first, baselines last (stable within each group). */
function orderSeries(
  benchmarks: string[],
  baselineNames: Set<string>,
): string[] {
  return [...benchmarks].sort(
    (a, b) => Number(baselineNames.has(a)) - Number(baselineNames.has(b)),
  );
}

/** Legend items for benchmark names, colored to match the dots. */
function seriesLegendItems(
  benchmarks: string[],
  baselineNames: Set<string>,
  colors: Map<string, string>,
): LegendItem[] {
  return orderSeries(benchmarks, baselineNames).map(bm => {
    const isBase = baselineNames.has(bm);
    return {
      color: colors.get(bm) ?? defaultSeriesColor,
      label: bm,
      style: (isBase ? "hollow-dot" : "filled-dot") as LegendItem["style"],
    };
  });
}

/** One legend entry per series with visible GC marks, tinted its series color.
 *  Disambiguation counts every series carrying GC events (like the pills), so a
 *  label doesn't flip between "full GC" and "full GC (name)" as pills toggle. */
function gcLegendItems(
  gcSeries: string[],
  allGcSeries: string[],
  baselineNames: Set<string>,
  colors: Map<string, string>,
): LegendItem[] {
  if (!gcSeries.length) return [];
  const multiCurrent =
    allGcSeries.filter(n => !baselineNames.has(n)).length > 1;
  return orderSeries(gcSeries, baselineNames).map(name => ({
    color: colors.get(name) ?? defaultSeriesColor,
    label: gcSeriesLabel(name, baselineNames.has(name), multiCurrent),
    style: "vertical-line" as const,
  }));
}

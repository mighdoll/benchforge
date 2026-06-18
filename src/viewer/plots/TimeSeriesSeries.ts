import type { LegendItem } from "./LegendUtils.ts";
import { seriesColor } from "./PlotTypes.ts";

interface LegendParams {
  hasWarmup: boolean;
  gcCount: number;
  pauseCount: number;
  hasHeap: boolean;
  hasBaselineHeap: boolean;
  hasRejected: boolean;
  benchmarks: string[];
  baselineNames: Set<string>;
}

/** Fallback swatch for a series name absent from the color map (steel blue). */
export const defaultSeriesColor = "#4682b4";

const gcViolet = "#7c3aed";

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
  const { hasWarmup, gcCount, pauseCount, hasHeap, hasBaselineHeap } = p;
  const { hasRejected, benchmarks, baselineNames } = p;
  const items: LegendItem[] = [];
  if (hasWarmup)
    items.push({ color: "#dc3545", label: "warmup", style: "hollow-dot" });
  items.push(...seriesLegendItems(benchmarks, baselineNames));
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
  if (gcCount > 0)
    items.push({ color: gcViolet, label: "full GC", style: "vertical-line" });
  return items;
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
): LegendItem[] {
  const colors = seriesColorMap(benchmarks, baselineNames);
  return orderSeries(benchmarks, baselineNames).map(bm => {
    const isBase = baselineNames.has(bm);
    return {
      color: colors.get(bm) ?? defaultSeriesColor,
      label: bm,
      style: (isBase ? "hollow-dot" : "filled-dot") as LegendItem["style"],
    };
  });
}

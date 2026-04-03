import * as Plot from "@observablehq/plot";
import * as d3 from "d3";
import { buildLegend, type LegendItem } from "./LegendUtils.ts";
import { plotLayout, type Sample } from "./PlotTypes.ts";

interface Bar {
  benchmark: string;
  count: number;
  x1: number;
  x2: number;
}

/** Create histogram + KDE plot for sample distribution */
export function createHistogramKde(
  allSamples: Sample[],
  benchmarkNames: string[],
): SVGSVGElement | HTMLElement {
  const { barData, binMin, binMax, yMax } = buildBarData(
    allSamples,
    benchmarkNames,
  );
  const { colorMap, legendItems } = buildColorData(benchmarkNames);

  return Plot.plot({
    ...plotLayout,
    x: {
      label: "Time (ms)",
      labelAnchor: "center",
      domain: [binMin, binMax],
      labelOffset: 45,
      tickFormat: (d: number) => d.toFixed(1),
      ticks: 5,
    },
    y: {
      label: "Count",
      labelAnchor: "top",
      labelArrow: false,
      grid: true,
      domain: [0, yMax],
    },
    marks: [
      Plot.rectY(barData, {
        x1: "x1",
        x2: "x2",
        y: "count",
        fill: (d: Bar) => colorMap.get(d.benchmark),
        fillOpacity: 0.6,
        tip: true,
        title: (d: Bar) => `${d.benchmark}: ${d.count}`,
      }),
      Plot.ruleY([0]),
      ...buildLegend({ xMin: binMin, xMax: binMax, yMax }, legendItems),
    ],
  });
}

/** Bin samples into grouped histogram bars for each benchmark */
function buildBarData(allSamples: Sample[], benchmarkNames: string[]) {
  const sortedValues = allSamples.map(d => d.value).sort((a, b) => a - b);
  const binMin = d3.quantile(sortedValues, 0.01)!;
  const binMax = d3.quantile(sortedValues, 0.99)!;
  const binCount = 25;
  const step = (binMax - binMin) / binCount;
  const thresholds = d3.range(1, binCount).map(i => binMin + i * step);
  const plotWidth = plotLayout.width;

  const bins = d3
    .bin<Sample, number>()
    .domain([binMin, binMax])
    .thresholds(thresholds)
    .value(d => d.value)(allSamples);

  const n = benchmarkNames.length;
  const unitsPerPx = (binMax - binMin) / plotWidth;
  const groupGapPx = 8;

  const barData: Bar[] = bins.flatMap(bin => {
    const counts = new Map<string, number>();
    for (const d of bin)
      counts.set(d.benchmark, (counts.get(d.benchmark) || 0) + 1);

    const full = bin.x1! - bin.x0!;
    const groupGap = Math.min(full * 0.5, unitsPerPx * groupGapPx);
    const start = bin.x0! + groupGap / 2;
    const w = (full - groupGap) / n;

    return benchmarkNames.map((benchmark, i) => {
      const x1 = start + i * w;
      const x2 = start + (i + 1) * w;
      return { benchmark, count: counts.get(benchmark) || 0, x1, x2 };
    });
  });

  const maxCount = d3.max(barData, d => d.count)! || 1;
  const yMax = maxCount * 1.15;

  return { barData, binMin, binMax, yMax };
}

/** Map benchmark names to colors and legend items using Observable 10 palette */
function buildColorData(benchmarkNames: string[]) {
  const scheme = (d3 as any).schemeObservable10;
  const color = (i: number) => scheme[i % 10];
  const colorMap = new Map(benchmarkNames.map((name, i) => [name, color(i)]));
  const legendItems: LegendItem[] = benchmarkNames.map((name, i) => ({
    color: color(i),
    label: name,
    style: "vertical-bar",
  }));
  return { colorMap, legendItems };
}

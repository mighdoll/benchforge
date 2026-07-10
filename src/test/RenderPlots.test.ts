import { expect, test } from "vitest";
import { baselineLabel } from "../report/Formatters.ts";
import { prepareBenchmarks } from "../viewer/plots/RenderPlots.ts";
import type { BenchmarkEntry, BenchmarkGroup } from "../viewer/ReportData.ts";

const zeroStats = { min: 0, max: 0, avg: 0, p50: 0, p75: 0, p99: 0, p999: 0 };

function entry(name: string, baseline?: BenchmarkEntry): BenchmarkEntry {
  return { name, samples: [1, 2, 3], stats: zeroStats, baseline };
}

test("baselineLabel is idempotent and drops redundant suffixes", () => {
  expect(baselineLabel(undefined)).toBe("baseline");
  expect(baselineLabel("baseline")).toBe("baseline");
  expect(baselineLabel("link")).toBe("link (baseline)");
  expect(baselineLabel("link (baseline)")).toBe("link (baseline)");
});

test("prepareBenchmarks surfaces each variant's own paired baseline (version mode)", () => {
  const group: BenchmarkGroup = {
    name: "WESL",
    benchmarks: [
      entry("link", entry("link (baseline)")),
      entry("parse", entry("parse (baseline)")),
    ],
  };
  const prepared = prepareBenchmarks(group);
  // baselines first, then the comparison variants
  expect(prepared.map(b => b.name)).toEqual([
    "link (baseline)",
    "parse (baseline)",
    "link",
    "parse",
  ]);
  expect(prepared.filter(b => b.isBaseline).map(b => b.name)).toEqual([
    "link (baseline)",
    "parse (baseline)",
  ]);
});

test("prepareBenchmarks names a lone version baseline 'baseline', like the tables", () => {
  const group: BenchmarkGroup = {
    name: "WESL",
    benchmarks: [entry("link", entry("link (baseline)"))],
  };
  expect(prepareBenchmarks(group).map(b => b.name)).toEqual([
    "baseline",
    "link",
  ]);
});

test("prepareBenchmarks uses a shared group baseline when a variant has none", () => {
  const group: BenchmarkGroup = {
    name: "WESL",
    baseline: entry("baseline"),
    benchmarks: [entry("link")],
  };
  expect(prepareBenchmarks(group).map(b => b.name)).toEqual([
    "baseline",
    "link",
  ]);
});

test("prepareBenchmarks shows the reference variant once in baselineVariant mode", () => {
  const group: BenchmarkGroup = {
    name: "Array Copy",
    baselineVariantId: "spread",
    benchmarks: [entry("slice", entry("spread (baseline)")), entry("spread")],
  };
  const prepared = prepareBenchmarks(group);
  // one "spread" (the reference, baseline-flagged), no duplicate "spread (baseline)"
  expect(prepared.map(b => b.name)).toEqual(["spread", "slice"]);
  expect(prepared.find(b => b.isBaseline)?.name).toBe("spread");
  expect(prepared.filter(b => b.name.includes("spread"))).toHaveLength(1);
});

test("prepareBenchmarks omits a filtered-out reference variant, matching the tables", () => {
  const group: BenchmarkGroup = {
    name: "Array Copy",
    baselineVariantId: "spread",
    benchmarks: [entry("slice", entry("spread (baseline)"))],
  };
  const prepared = prepareBenchmarks(group);
  expect(prepared.map(b => b.name)).toEqual(["slice"]);
  expect(prepared.some(b => b.isBaseline)).toBe(false);
});

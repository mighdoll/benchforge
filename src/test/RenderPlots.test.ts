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

test("prepareBenchmarks surfaces each variant's own paired baseline", () => {
  const group: BenchmarkGroup = {
    name: "WESL",
    benchmarks: [entry("link", entry("link (baseline)"))],
  };
  const prepared = prepareBenchmarks(group);
  expect(prepared.map(b => b.name)).toEqual(["link (baseline)", "link"]);
  expect(prepared.find(b => b.isBaseline)?.name).toBe("link (baseline)");
});

test("prepareBenchmarks prefers a shared group baseline when present", () => {
  const group: BenchmarkGroup = {
    name: "WESL",
    baseline: entry("baseline"),
    benchmarks: [entry("link", entry("ignored (baseline)"))],
  };
  expect(prepareBenchmarks(group).map(b => b.name)).toEqual([
    "baseline",
    "link",
  ]);
});

test("prepareBenchmarks de-duplicates a baseline shared across variants", () => {
  const shared = entry("ref (baseline)");
  const group: BenchmarkGroup = {
    name: "WESL",
    benchmarks: [entry("a", shared), entry("b", shared)],
  };
  expect(prepareBenchmarks(group).filter(b => b.isBaseline)).toHaveLength(1);
});

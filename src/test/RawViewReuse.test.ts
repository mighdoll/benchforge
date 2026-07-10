import { expect, test } from "vitest";
import { metricSection, type ReportGroup } from "../report/BenchmarkReport.ts";
import { integer } from "../report/Formatters.ts";
import { prepareHtmlData } from "../report/HtmlReport.ts";
import type { ViewerEntry, ViewerSection } from "../viewer/ReportData.ts";
import {
  batchOffsets,
  constBatches,
  repeatedBatches,
  zeroStats,
} from "./TestUtils.ts";

/** The primary-row entry for `runName` in the section titled `title`. */
function primaryEntry(
  sections: ViewerSection[] | undefined,
  title: string,
  runName: string,
): ViewerEntry | undefined {
  const section = sections?.find(s => s.title === title);
  const row = section?.rows.find(r => r.primary);
  return row?.entries.find(e => e.runName === runName);
}

test("raw view reuses an untrimmed track's diff without re-applying toDisplay", () => {
  const locSection = metricSection({
    title: "lines / sec",
    higherIsBetter: true,
    toDisplay: (ms: number) => 1000 / ms,
    formatter: integer,
  });
  // "current" and its baseline are near-constant: trimming is a no-op for this
  // pair, so the raw view reuses its cached (already display-domain) diff.
  const current = constBatches(24, 40, 1.15, "current");
  const currentBase = { ...constBatches(24, 40, 4), name: "baseline" };
  // "noisy" has one 10x-slow batch that Tukey trimming removes, which forces
  // the raw (untrimmed) section rebuild to exist at all.
  const values = [...Array.from({ length: 23 }, () => 5), 50];
  const noisy = {
    name: "noisy",
    samples: repeatedBatches(values, 40),
    batchOffsets: batchOffsets(24, 40),
    time: zeroStats,
  };
  const noisyBase = { ...constBatches(24, 40, 5), name: "baseline" };
  const groups: ReportGroup[] = [
    {
      name: "parse",
      reports: [
        {
          name: "current",
          measuredResults: current,
          baseline: { name: "baseline", measuredResults: currentBase },
        },
        {
          name: "noisy",
          measuredResults: noisy,
          baseline: { name: "baseline", measuredResults: noisyBase },
        },
      ],
    },
  ];

  const data = prepareHtmlData(groups, {
    sections: [locSection],
    resamples: 200,
  });
  const group = data.groups[0];
  expect(group.rawSections).toBeDefined();

  const trimmed = primaryEntry(group.sections, "lines / sec", "current");
  const raw = primaryEntry(group.rawSections, "lines / sec", "current");
  // 1.15ms vs 4ms is -71.25% in time, +247.8% in the loc/sec display domain.
  expect(trimmed?.comparisonCI?.percent).toBeCloseTo(247.8, 0);
  // Before the guard in comparisonMetric, the raw rebuild re-ran displayDiffCI
  // on the reused display-domain diff; the reciprocal is an involution, so the
  // raw percent silently reverted to the time-domain -71.2%.
  expect(raw?.comparisonCI?.percent).toBeCloseTo(
    trimmed!.comparisonCI!.percent,
    6,
  );
});

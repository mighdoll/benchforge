import { expect, test } from "vitest";
import { matrixToReportGroups } from "../cli/CliReport.ts";
import type { MatrixResults } from "../matrix/BenchMatrix.ts";
import { createMeasuredResults } from "./TestUtils.ts";

/** A matrix where quicksort compares against the "native sort" baselineVariant. */
function sortingMatrix(): MatrixResults {
  const measured = () => createMeasuredResults([0, 30]);
  return {
    name: "Array Sorting",
    baselineVariant: "native sort",
    variants: [
      {
        id: "quicksort",
        cases: [
          {
            caseId: "numbers",
            measured: measured(),
            baseline: measured(),
            baselineId: "native sort",
          },
        ],
      },
      {
        id: "native sort",
        cases: [{ caseId: "numbers", measured: measured() }],
      },
    ],
  };
}

/** The same matrix as a --filter run that excludes the baseline variant: only
 *  quicksort survives, still carrying its interleaved "native sort" baseline. */
function filteredSortingMatrix(): MatrixResults {
  const full = sortingMatrix();
  return {
    ...full,
    variants: full.variants.filter(v => v.id !== "native sort"),
  };
}

test("baseline report is named for the baseline variant, not the current one", () => {
  const [group] = matrixToReportGroups([sortingMatrix()]);
  const quicksort = group.reports.find(r => r.name === "quicksort")!;
  expect(quicksort.baseline?.name).toBe("native sort (baseline)");
});

test("the baseline variant itself has no baseline of its own", () => {
  const [group] = matrixToReportGroups([sortingMatrix()]);
  const native = group.reports.find(r => r.name === "native sort")!;
  expect(native.baseline).toBeUndefined();
});

test("filtering out the baseline variant keeps peer-baseline mode", () => {
  const [group] = matrixToReportGroups([filteredSortingMatrix()]);
  expect(group.reports.map(r => r.name)).toEqual(["quicksort"]);
  // configured baselineVariant still selects peer-baseline mode (not version
  // mode), so quicksort labels its reference "native sort", not <current>.
  expect(group.baselineVariantId).toBe("native sort");
  expect(group.reports[0].baseline?.name).toBe("native sort (baseline)");
});

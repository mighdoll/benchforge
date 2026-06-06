import { expect, test } from "vitest";
import { matrixToReportGroups } from "../cli/CliReport.ts";
import type { MatrixResults } from "../matrix/BenchMatrix.ts";
import { createMeasuredResults } from "./TestUtils.ts";

/** A matrix where quicksort compares against the "native sort" baselineVariant. */
function sortingMatrix(): MatrixResults {
  const measured = () => createMeasuredResults([0, 30]);
  return {
    name: "Array Sorting",
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
      { id: "native sort", cases: [{ caseId: "numbers", measured: measured() }] },
    ],
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

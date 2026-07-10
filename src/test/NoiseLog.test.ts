import { expect, test } from "vitest";
import { abNoiseRecords, calibrateNoiseRecord } from "../report/NoiseLog.ts";
import type { CalibrationResult } from "../runners/Calibration.ts";
import type { NoiseFloor } from "../stats/NoiseFloor.ts";
import type { ReportData } from "../viewer/ReportData.ts";
import { zeroStats } from "./TestUtils.ts";

const floor: NoiseFloor = {
  halfWidthPct: 0.4,
  dispersionPct: 0.53,
  batches: 24,
  driftPct: 0.12,
  crossRoundAcf: 0.05,
};

/** A one-case ReportData with a noise floor and a "faster" primary comparison. */
function abData(noiseFloor?: NoiseFloor): ReportData {
  return {
    groups: [
      {
        name: "sort",
        benchmarks: [{ name: "current", samples: [], stats: zeroStats }],
        noiseFloor,
        sections: [
          {
            title: "time",
            rows: [
              {
                label: "mean",
                primary: true,
                entries: [
                  {
                    runName: "current",
                    value: "1us",
                    comparisonCI: {
                      percent: -2.34,
                      ci: [-3, -1],
                      direction: "faster",
                    },
                  },
                  { runName: "baseline", value: "1us", isBaseline: true },
                ],
              },
            ],
          },
        ],
      },
    ],
    metadata: {
      timestamp: "2026-07-01T00:00:00Z",
      bencherVersion: "0",
      cliArgs: { "equiv-margin": 0.5 },
    },
  };
}

test("abNoiseRecords carries the floor, verdict, and margin per case", () => {
  const records = abNoiseRecords(abData(floor), "testhost");
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    kind: "ab",
    machine: "testhost",
    benchmark: "sort",
    batches: 24,
    halfWidthPct: 0.4,
    dispersionPct: 0.53,
    driftPct: 0.12,
    crossRoundAcf: 0.05,
    equivMargin: 0.5,
    verdict: "better",
    deltaPct: -2.34,
    timestamp: "2026-07-01T00:00:00Z",
  });
});

test("abNoiseRecords skips cases without a noise floor", () => {
  expect(abNoiseRecords(abData(undefined), "h")).toHaveLength(0);
});

test("calibrateNoiseRecord maps the calibration summary", () => {
  const result = {
    runs: 5,
    batches: 100,
    pointEstimates: [],
    ciHalfWidths: [],
    summary: {
      meanPoint: 0.01,
      scatterStd: 0.22,
      scatterHalfWidth: 0.43,
      meanCiHalfWidth: 0.31,
      suggestedMargin: 0.5,
      overconfident: false,
    },
  } satisfies CalibrationResult;
  const record = calibrateNoiseRecord(
    result,
    "2026-07-01T00:00:00Z",
    "bevy",
    "h",
  );
  expect(record).toMatchObject({
    kind: "calibrate",
    benchmark: "bevy",
    batches: 100,
    halfWidthPct: 0.31,
    dispersionPct: 0.22,
    equivMargin: 0.5,
    machine: "h",
  });
  expect(record.verdict).toBeUndefined();
});

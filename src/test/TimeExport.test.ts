import { expect, test } from "vitest";
import { timeProfileToSpeedscope } from "../export/TimeExport.ts";
import type { TimeProfile } from "../profiling/time/TimeSampler.ts";

/** Build a minimal TimeProfile for testing */
function mockProfile(): TimeProfile {
  return {
    nodes: [
      {
        id: 1,
        callFrame: { functionName: "", url: "", lineNumber: -1 },
        children: [2],
      },
      {
        id: 2,
        callFrame: {
          functionName: "main",
          url: "file:///app.ts",
          lineNumber: 9,
          columnNumber: 0,
        },
        children: [3],
      },
      {
        id: 3,
        callFrame: {
          functionName: "compute",
          url: "file:///app.ts",
          lineNumber: 19,
          columnNumber: 4,
        },
        hitCount: 5,
      },
    ],
    startTime: 0,
    endTime: 5000,
    samples: [3, 3, 2, 3, 3],
    timeDeltas: [1000, 1000, 1000, 1000, 1000],
  };
}

test("converts TimeProfile to valid SpeedScope format", () => {
  const profile = mockProfile();
  const file = timeProfileToSpeedscope("test-bench", profile);

  expect(file.$schema).toBe(
    "https://www.speedscope.app/file-format-schema.json",
  );
  expect(file.exporter).toBe("benchforge");
  expect(file.profiles).toHaveLength(1);

  const p = file.profiles[0];
  expect(p.type).toBe("sampled");
  expect(p.name).toBe("test-bench");
  expect(p.unit).toBe("microseconds");
  expect(p.samples).toHaveLength(5);
  expect(p.weights).toEqual([1000, 1000, 1000, 1000, 1000]);
  expect(p.endValue).toBe(5000);
});

test("resolves stacks from leaf to root (root-first order)", () => {
  const profile = mockProfile();
  const file = timeProfileToSpeedscope("test", profile);

  const p = file.profiles[0];
  const frames = file.shared.frames;

  // Sample at node 3 (compute) should have stack: [main, compute]
  const deepStack = p.samples[0];
  expect(deepStack).toHaveLength(2); // root is skipped
  expect(frames[deepStack[0]].name).toBe("main");
  expect(frames[deepStack[1]].name).toBe("compute");

  // Sample at node 2 (main) should have stack: [main]
  const shallowStack = p.samples[2];
  expect(shallowStack).toHaveLength(1);
  expect(frames[shallowStack[0]].name).toBe("main");
});

test("deduplicates shared frames", () => {
  const profile = mockProfile();
  const file = timeProfileToSpeedscope("test", profile);

  // "main" and "compute" — only 2 unique frames
  expect(file.shared.frames).toHaveLength(2);
});

test("handles empty samples gracefully", () => {
  const profile: TimeProfile = {
    nodes: [
      { id: 1, callFrame: { functionName: "", url: "", lineNumber: -1 } },
    ],
    startTime: 0,
    endTime: 0,
    samples: [],
    timeDeltas: [],
  };
  const file = timeProfileToSpeedscope("empty", profile);

  expect(file.profiles[0].samples).toHaveLength(0);
  expect(file.profiles[0].weights).toHaveLength(0);
  expect(file.profiles[0].endValue).toBe(0);
});

test("converts 0-indexed V8 lines to 1-indexed", () => {
  const profile = mockProfile();
  const file = timeProfileToSpeedscope("test", profile);

  const mainFrame = file.shared.frames.find(f => f.name === "main")!;
  expect(mainFrame.line).toBe(10); // lineNumber 9 -> line 10
  expect(mainFrame.col).toBe(1); // columnNumber 0 -> col 1
});

test("anonymous functions get location hint in name", () => {
  const profile: TimeProfile = {
    nodes: [
      {
        id: 1,
        callFrame: { functionName: "", url: "", lineNumber: -1 },
        children: [2],
      },
      {
        id: 2,
        callFrame: {
          functionName: "",
          url: "file:///lib/utils.ts",
          lineNumber: 41,
        },
      },
    ],
    startTime: 0,
    endTime: 1000,
    samples: [2],
    timeDeltas: [1000],
  };
  const file = timeProfileToSpeedscope("test", profile);

  expect(file.shared.frames[0].name).toBe("(anonymous utils.ts:42)");
});

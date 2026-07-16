import { expect, test } from "vitest";
import { userOnlySpeedscope } from "../export/SpeedscopeFilter.ts";
import type { SpeedscopeFile } from "../export/SpeedscopeTypes.ts";

function sampleFile(): SpeedscopeFile {
  return {
    $schema: "https://www.speedscope.app/file-format-schema.json",
    shared: {
      frames: [
        { name: "userFn", file: "/src/app.ts", line: 3 }, // 0 user
        { name: "post", file: "node:inspector", line: 1 }, // 1 node internal
        { name: "(garbage collector)" }, // 2 no file
        { name: "parse", file: "/src/parse.ts", line: 5 }, // 3 user
      ],
    },
    profiles: [
      {
        type: "sampled",
        name: "b",
        unit: "microseconds",
        startValue: 0,
        endValue: 35,
        samples: [[0, 1, 3], [2], [0, 3]],
        weights: [10, 20, 5],
      },
    ],
  };
}

test("splices node internals and no-url frames, preserving weights", () => {
  const out = userOnlySpeedscope(sampleFile(), true);
  expect(out?.profiles[0].samples).toEqual([[0, 3], [], [0, 3]]);
  expect(out?.profiles[0].weights).toEqual([10, 20, 5]);
});

test("returns the file untouched when userOnly is off", () => {
  const file = sampleFile();
  expect(userOnlySpeedscope(file, false)).toBe(file);
});

test("passes through undefined", () => {
  expect(userOnlySpeedscope(undefined, true)).toBeUndefined();
});

import { expect, test } from "vitest";
import {
  annotateFramesWithCounts,
  buildCoverageMap,
} from "../export/CoverageExport.ts";
import type { CoverageData } from "../profiling/coverage/CoverageTypes.ts";

const source = `function foo() {
  return 1;
}
function bar() {
  return 2;
}
const baz = () => 3;
`;

const coverage: CoverageData = {
  scripts: [
    {
      url: "file:///test.js",
      functions: [
        {
          functionName: "foo",
          ranges: [{ startOffset: 0, endOffset: 30, count: 10 }],
        },
        {
          functionName: "bar",
          ranges: [{ startOffset: 31, endOffset: 60, count: 5 }],
        },
        {
          functionName: "",
          ranges: [{ startOffset: 61, endOffset: 80, count: 3 }],
        },
      ],
    },
  ],
};

test("buildCoverageMap resolves offsets to lines", () => {
  const result = buildCoverageMap(coverage, { "file:///test.js": source });

  expect(result.map.has("file:///test.js")).toBe(true);
  const entries = result.map.get("file:///test.js")!;
  expect(entries).toHaveLength(3);

  const foo = entries.find(e => e.functionName === "foo");
  expect(foo).toBeDefined();
  expect(foo!.startLine).toBe(1);
  expect(foo!.count).toBe(10);

  const bar = entries.find(e => e.functionName === "bar");
  expect(bar).toBeDefined();
  expect(bar!.startLine).toBe(4);
  expect(bar!.count).toBe(5);

  // byName aggregates across all scripts
  expect(result.byName.get("foo")).toBe(10);
  expect(result.byName.get("bar")).toBe(5);
});

test("annotateFramesWithCounts appends [N] to matched frames", () => {
  const result = buildCoverageMap(coverage, { "file:///test.js": source });

  const frames = [
    { name: "foo", file: "file:///test.js", line: 1 },
    { name: "bar", file: "file:///test.js", line: 4 },
    { name: "unmatched", file: "file:///other.js", line: 1 },
  ];

  annotateFramesWithCounts(frames, result);

  expect(frames[0].name).toBe("foo [10]");
  expect(frames[1].name).toBe("bar [5]");
  expect(frames[2].name).toBe("unmatched"); // no coverage data for this file
});

test("annotateFramesWithCounts falls back to name-only for frames without file", () => {
  const result = buildCoverageMap(coverage, { "file:///test.js": source });

  const frames = [
    { name: "foo" }, // no file — should match by name
    { name: "bar" },
    { name: "(anonymous)" }, // anonymous — should not match by name
  ];

  annotateFramesWithCounts(frames, result);

  expect(frames[0].name).toBe("foo [10]");
  expect(frames[1].name).toBe("bar [5]");
  expect(frames[2].name).toBe("(anonymous)");
});

test("annotateFramesWithCounts formats large counts", () => {
  const bigCoverage: CoverageData = {
    scripts: [
      {
        url: "file:///big.js",
        functions: [
          {
            functionName: "hot",
            ranges: [{ startOffset: 0, endOffset: 10, count: 1_500_000 }],
          },
        ],
      },
    ],
  };
  const result = buildCoverageMap(bigCoverage, {
    "file:///big.js": "function hot() {}",
  });
  const frames = [{ name: "hot", file: "file:///big.js", line: 1 }];

  annotateFramesWithCounts(frames, result);

  expect(frames[0].name).toBe("hot [1.5M]");
});

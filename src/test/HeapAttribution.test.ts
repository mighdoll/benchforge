import { expect, test } from "vitest";
import {
  aggregateSites,
  type HeapSite,
} from "../profiling/node/HeapSampleReport.ts";
import type { HeapProfile } from "../profiling/node/HeapSampler.ts";
import type { ReportGroup } from "../report/BenchmarkReport.ts";
import { prepareHtmlData } from "../report/HtmlReport.ts";

const zeroTime = { min: 0, max: 0, avg: 0, p50: 0, p75: 0, p99: 0, p999: 0 };

/** A tiny heap profile: a user allocation site under a user caller, plus a
 *  node-internal site. Line/col are 0-indexed (resolveCallFrame adds 1). */
function sampleHeapProfile(): HeapProfile {
  return {
    head: {
      callFrame: { functionName: "root", url: "", lineNumber: 0 },
      selfSize: 0,
      id: 1,
      children: [
        {
          callFrame: {
            functionName: "parseModule",
            url: "user.ts",
            lineNumber: 4,
          },
          selfSize: 0,
          id: 2,
          children: [
            {
              callFrame: {
                functionName: "makeToken",
                url: "user.ts",
                lineNumber: 19,
                columnNumber: 7,
              },
              selfSize: 2000,
              id: 3,
            },
          ],
        },
        {
          callFrame: {
            functionName: "concat",
            url: "node:internal/util",
            lineNumber: 2,
          },
          selfSize: 800,
          id: 4,
        },
      ],
    },
    samples: [
      { nodeId: 3, size: 1000, ordinal: 0 },
      { nodeId: 3, size: 1000, ordinal: 1 },
      { nodeId: 4, size: 800, ordinal: 2 },
    ],
  };
}

/** One report group carrying a single benchmark with the heap profile attached. */
function heapGroups(): ReportGroup[] {
  return [
    {
      name: "g",
      reports: [
        {
          name: "current",
          measuredResults: {
            name: "current",
            samples: [1],
            time: zeroTime,
            heapProfile: sampleHeapProfile(),
          },
        },
      ],
    },
  ];
}

test("prepareHtmlData populates heapSites with location, callers, and pct", () => {
  const data = prepareHtmlData(heapGroups(), { heapReport: { topN: 20 } });
  const entry = data.groups[0].benchmarks[0];
  const sites = entry.heapSites!;

  expect(sites).toHaveLength(2);
  expect(sites[0].name).toBe("makeToken");
  expect(sites[0].location).toBe("user.ts:20:8");
  expect(sites[0].callers).toEqual(["parseModule"]);
  expect(sites[0].pct).toBeCloseTo(71.4, 0);
  // node-internal frame has no user-code caller, so no caller chain
  expect(sites[1].name).toBe("concat");
  expect(sites[1].callers).toBeUndefined();
  expect(entry.heapSummary).toEqual({
    totalBytes: 2800,
    userBytes: 2000,
    sampleCount: 3,
  });
});

test("prepareHtmlData respects heapReport topN", () => {
  const data = prepareHtmlData(heapGroups(), { heapReport: { topN: 1 } });
  const sites = data.groups[0].benchmarks[0].heapSites!;
  expect(sites).toHaveLength(1);
  expect(sites[0].name).toBe("makeToken");
});

test("prepareHtmlData userOnly drops internals and rebases pct to user code", () => {
  const data = prepareHtmlData(heapGroups(), {
    heapReport: { topN: 20, userOnly: true },
  });
  const sites = data.groups[0].benchmarks[0].heapSites!;
  expect(sites).toHaveLength(1);
  expect(sites[0].name).toBe("makeToken");
  expect(sites[0].pct).toBeCloseTo(100, 5);
});

test("unknown column does not merge distinct functions on same line", () => {
  const sites: HeapSite[] = [
    { name: "Foo", url: "test.ts", line: 10, col: undefined, bytes: 100 },
    { name: "Bar", url: "test.ts", line: 10, col: undefined, bytes: 200 },
  ];
  const aggregated = aggregateSites(sites);
  expect(aggregated).toHaveLength(2);
});

test("same column merges regardless of function name", () => {
  const sites: HeapSite[] = [
    { name: "Foo", url: "test.ts", line: 10, col: 5, bytes: 100 },
    { name: "Foo", url: "test.ts", line: 10, col: 5, bytes: 200 },
  ];
  const aggregated = aggregateSites(sites);
  expect(aggregated).toHaveLength(1);
  expect(aggregated[0].bytes).toBe(300);
});

test("internal frames don't count against the caller depth budget", () => {
  // site <- wrap (node-internal) <- handler (user); with stackDepth 1 the
  // internal nearest caller is skipped, not counted, so handler still shows.
  const profile: HeapProfile = {
    head: {
      callFrame: { functionName: "root", url: "", lineNumber: 0 },
      selfSize: 0,
      id: 1,
      children: [
        {
          callFrame: { functionName: "handler", url: "user.ts", lineNumber: 2 },
          selfSize: 0,
          id: 2,
          children: [
            {
              callFrame: {
                functionName: "wrap",
                url: "node:internal/util",
                lineNumber: 8,
              },
              selfSize: 0,
              id: 3,
              children: [
                {
                  callFrame: {
                    functionName: "alloc",
                    url: "user.ts",
                    lineNumber: 30,
                  },
                  selfSize: 500,
                  id: 4,
                },
              ],
            },
          ],
        },
      ],
    },
    samples: [{ nodeId: 4, size: 500, ordinal: 0 }],
  };
  const groups = heapGroups();
  groups[0].reports[0].measuredResults!.heapProfile = profile;
  const data = prepareHtmlData(groups, {
    heapReport: { topN: 20, stackDepth: 1 },
  });
  const sites = data.groups[0].benchmarks[0].heapSites!;
  expect(sites[0].name).toBe("alloc");
  expect(sites[0].callers).toEqual(["handler"]);
});

test("aggregation preserves distinct caller stacks", () => {
  const stackA = [
    { name: "root", url: "a.ts", line: 1, col: 0 },
    { name: "foo", url: "a.ts", line: 10, col: 0 },
    { name: "alloc", url: "a.ts", line: 20, col: 5 },
  ];
  const stackB = [
    { name: "root", url: "a.ts", line: 1, col: 0 },
    { name: "bar", url: "a.ts", line: 15, col: 0 },
    { name: "alloc", url: "a.ts", line: 20, col: 5 },
  ];
  const sites: HeapSite[] = [
    { name: "alloc", url: "a.ts", line: 20, col: 5, bytes: 800, stack: stackA },
    { name: "alloc", url: "a.ts", line: 20, col: 5, bytes: 200, stack: stackB },
  ];
  const aggregated = aggregateSites(sites);

  expect(aggregated).toHaveLength(1);
  expect(aggregated[0].bytes).toBe(1000);
  expect(aggregated[0].callers).toHaveLength(2);
  // Primary stack should be the highest-bytes path (foo)
  expect(aggregated[0].stack![1].name).toBe("foo");
  // Callers sorted by bytes descending
  expect(aggregated[0].callers![0].bytes).toBe(800);
  expect(aggregated[0].callers![1].bytes).toBe(200);
});

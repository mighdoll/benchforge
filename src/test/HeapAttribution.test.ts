import { expect, test } from "vitest";
import {
  aggregateSites,
  type HeapSite,
} from "../profiling/node/HeapSampleReport.ts";

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

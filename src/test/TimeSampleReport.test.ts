import { expect, test } from "vitest";
import {
  siteKey,
  sortedTimeSites,
  summarizeTimeProfile,
} from "../profiling/node/TimeSampleReport.ts";
import type {
  TimeProfile,
  TimeProfileNode,
} from "../profiling/node/TimeSampler.ts";
import { summarizeTime } from "../report/HtmlReport.ts";

/** A profile node; lineNumber is V8's 0-indexed value (resolves to line+1). */
function node(
  id: number,
  functionName: string,
  url: string,
  lineNumber: number,
): TimeProfileNode {
  return {
    id,
    callFrame: { functionName, url, lineNumber, columnNumber: 0 },
    children: [],
  };
}

function profile(
  nodes: TimeProfileNode[],
  samples: number[],
  timeDeltas: number[],
): TimeProfile {
  return { nodes, startTime: 0, endTime: 0, samples, timeDeltas };
}

/** Sample/delta arrays where each spec contributes `ticks` samples of node `id`,
 *  each carrying `us` microseconds (so the node's selfUs = ticks * us). Enough
 *  ticks keeps a baseline delta above the sampling-noise floor. */
function ticks(specs: { id: number; ticks: number; us: number }[]): {
  samples: number[];
  timeDeltas: number[];
} {
  const samples: number[] = [];
  const timeDeltas: number[] = [];
  for (const s of specs)
    for (let i = 0; i < s.ticks; i++) {
      samples.push(s.id);
      timeDeltas.push(s.us);
    }
  return { samples, timeDeltas };
}

/** A one-batch profile from a {function name: ticks} map (1us per tick), so each
 *  function's share of the batch is its ticks over the batch total. `dir` sets
 *  the path prefix (the basename is what the cross-build join keys on). */
function batch(funcs: Record<string, number>, dir = "/src"): TimeProfile {
  const names = Object.keys(funcs);
  const nodes = names.map((n, i) => node(i + 2, n, `${dir}/${n}.ts`, 0));
  const spec = names.map((n, i) => ({ id: i + 2, ticks: funcs[n], us: 1 }));
  const { samples, timeDeltas } = ticks(spec);
  return profile(nodes, samples, timeDeltas);
}

/** N identical copies of a batch (a stable function across batches). */
function repeat(b: TimeProfile, n: number): TimeProfile[] {
  return Array.from({ length: n }, () => b);
}

test("folds self-time per node and merges a function across call sites", () => {
  // nodes 2 and 4 are both alpha@/a.ts (same function, distinct call sites)
  const nodes = [
    node(2, "alpha", "/a.ts", 9),
    node(3, "beta", "/b.ts", 19),
    node(4, "alpha", "/a.ts", 9),
  ];
  const { byKey, totalUs } = summarizeTimeProfile(
    profile(nodes, [2, 2, 3, 4], [10, 10, 5, 20]),
  );
  expect(totalUs).toBe(45);
  expect(byKey.size).toBe(2);
  expect(byKey.get("alpha@a.ts")?.selfUs).toBe(40);
  expect(byKey.get("beta@b.ts")?.selfUs).toBe(5);
  // ticks accumulate across both call sites (node 2: 2 ticks, node 4: 1 tick)
  expect(byKey.get("alpha@a.ts")?.ticks).toBe(3);
  // 1-indexed display line
  expect(byKey.get("alpha@a.ts")?.line).toBe(10);
});

test("sortedTimeSites ranks by self-time descending", () => {
  const nodes = [node(2, "alpha", "/a.ts", 0), node(3, "beta", "/b.ts", 0)];
  const { byKey } = summarizeTimeProfile(
    profile(nodes, [3, 2, 2], [5, 10, 10]),
  );
  const sites = sortedTimeSites(byKey);
  expect(sites.map(s => s.name)).toEqual(["alpha", "beta"]);
  expect(sites[0].selfUs).toBe(20);
});

test("empty profile when sample/delta arrays are missing", () => {
  const bare = { nodes: [node(1, "x", "/x.ts", 0)], startTime: 0, endTime: 0 };
  const { byKey, totalUs } = summarizeTimeProfile(bare as TimeProfile);
  expect(byKey.size).toBe(0);
  expect(totalUs).toBe(0);
});

test("siteKey joins named functions by name+basename, line-qualifies anonymous", () => {
  // keyed on the file base name, ignoring directory and line
  expect(siteKey({ name: "alpha", url: "/src/a.ts", line: 10 })).toBe(
    "alpha@a.ts",
  );
  // a different build directory and line for the same function still matches
  expect(siteKey({ name: "alpha", url: "/other/build/a.ts", line: 99 })).toBe(
    "alpha@a.ts",
  );
  // anonymous frames have no stable identity, so they stay line-qualified
  expect(siteKey({ name: "(anonymous)", url: "/a.ts", line: 10, col: 2 })).toBe(
    "(anonymous)@a.ts:10:2",
  );
});

test("summarizeTime matches functions across builds in different directories", () => {
  // current and baseline live in different worktrees: same basename, different
  // path prefix. A consistent share shift (0.6 -> 0.4) across batches is real,
  // so its CI sits well above zero.
  const cur = repeat(batch({ peek: 60, other: 40 }, "/work/pkg/src"), 6);
  const base = repeat(batch({ peek: 40, other: 60 }, "/baseline/main/src"), 6);
  const peek = summarizeTime(cur, base, {
    topN: 20,
    userOnly: false,
  }).rows.find(r => r.name === "peek");
  expect(peek?.baseUs).toBe(40 * 6); // matched despite differing path
  expect(peek?.deltaPct).toBeCloseTo(50); // share 0.6 vs 0.4
  // identical batches -> a degenerate, tight CI right at the point estimate
  expect(peek?.deltaCI?.[0]).toBeCloseTo(50);
  expect(peek?.deltaCI?.[1]).toBeCloseTo(50);
});

test("summarizeTime reports a share shift with a CI, marks unmatched new", () => {
  const cur = repeat(batch({ alpha: 60, beta: 40 }), 6);
  const base = repeat(batch({ alpha: 40, beta: 60 }), 6);
  const { rows } = summarizeTime(cur, base, { topN: 20, userOnly: false });

  const alpha = rows.find(r => r.name === "alpha");
  expect(alpha?.deltaPct).toBeCloseTo(50); // share 0.6 vs 0.4
  expect(alpha?.deltaCI?.[0]).toBeGreaterThan(0); // CI excludes zero

  // a function present only in current has no baseline match -> "new"
  const withFresh = summarizeTime(
    repeat(batch({ alpha: 50, fresh: 50 }), 6),
    repeat(batch({ alpha: 100 }), 6),
    { topN: 20, userOnly: false },
  );
  const fresh = withFresh.rows.find(r => r.name === "fresh");
  expect(fresh?.baseUs).toBeUndefined();
  expect(fresh?.deltaPct).toBeUndefined();
});

test("summarizeTime CI spans zero when the shift is swamped by between-batch noise", () => {
  // alpha's share swings 0.7/0.3 batch to batch (mean 0.5); baseline sits at 0.5.
  // The point delta is ~0 and the CI straddles zero -> no clear change.
  const cur = [
    batch({ alpha: 70, other: 30 }),
    batch({ alpha: 30, other: 70 }),
    batch({ alpha: 70, other: 30 }),
    batch({ alpha: 30, other: 70 }),
    batch({ alpha: 70, other: 30 }),
    batch({ alpha: 30, other: 70 }),
  ];
  const base = repeat(batch({ alpha: 50, other: 50 }), 6);
  const alpha = summarizeTime(cur, base, {
    topN: 20,
    userOnly: false,
  }).rows.find(r => r.name === "alpha");
  expect(alpha?.deltaPct).toBeCloseTo(0); // mean share 0.5 vs 0.5
  expect(alpha?.deltaCI?.[0]).toBeLessThan(0); // CI straddles zero
  expect(alpha?.deltaCI?.[1]).toBeGreaterThan(0);
});

test("summarizeTime withholds a delta when there are too few batches", () => {
  // a real share shift, but only 2 batches per side -- not enough to bootstrap a
  // CI, so the delta is withheld (renders "~") rather than asserted.
  const cur = repeat(batch({ alpha: 60, other: 40 }), 2);
  const base = repeat(batch({ alpha: 40, other: 60 }), 2);
  const { rows } = summarizeTime(cur, base, { topN: 20, userOnly: false });
  const alpha = rows.find(r => r.name === "alpha");
  expect(alpha?.baseUs).toBe(40 * 2); // matched
  expect(alpha?.deltaPct).toBeUndefined(); // too few batches -> "~"
  expect(alpha?.deltaCI).toBeUndefined();
});

test("summarizeTime topN and user-only filtering", () => {
  const cur = profile(
    [
      node(2, "alpha", "/a.ts", 0),
      node(3, "internal", "node:internal/foo", 0),
      node(4, "beta", "/b.ts", 0),
    ],
    [2, 3, 4],
    [30, 20, 10],
  );
  const all = summarizeTime([cur], undefined, { topN: 2, userOnly: false });
  expect(all.rows).toHaveLength(2);
  expect(all.rows.map(r => r.name)).toEqual(["alpha", "internal"]);

  const userOnly = summarizeTime([cur], undefined, {
    topN: 20,
    userOnly: true,
  });
  expect(userOnly.rows.map(r => r.name)).toEqual(["alpha", "beta"]);
});

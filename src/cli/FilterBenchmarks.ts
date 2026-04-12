import type { BenchSuite } from "../runners/BenchmarkSpec.ts";

/** Filter suite benchmarks by name pattern (substring or regex). */
export function filterBenchmarks(
  suite: BenchSuite,
  filter?: string,
  removeEmpty = true,
): BenchSuite {
  if (!filter) return suite;
  const regex = createFilterRegex(filter);
  const groups = suite.groups
    .map(group => ({
      ...group,
      benchmarks: group.benchmarks.filter(bench =>
        regex.test(stripCaseSuffix(bench.name)),
      ),
      baseline:
        group.baseline && regex.test(stripCaseSuffix(group.baseline.name))
          ? group.baseline
          : undefined,
    }))
    .filter(group => !removeEmpty || group.benchmarks.length > 0);
  if (groups.every(g => g.benchmarks.length === 0)) {
    throw new Error(`No benchmarks match filter: "${filter}"`);
  }
  return { name: suite.name, groups };
}

/** Create regex from filter string. Uses literal prefix match unless the string looks like regex. */
function createFilterRegex(filter: string): RegExp {
  const isSlashed = filter.startsWith("/") && filter.endsWith("/");
  const looksLikeRegex =
    isSlashed ||
    /[*?[|]/.test(filter) ||
    filter.startsWith("^") ||
    filter.endsWith("$");

  if (!looksLikeRegex) return new RegExp("^" + escapeRegex(filter), "i");

  const pattern = isSlashed ? filter.slice(1, -1) : filter;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(escapeRegex(filter), "i");
  }
}

/** Strip case suffix like " [large]" from benchmark name for filtering. */
function stripCaseSuffix(name: string): string {
  return name.replace(/ \[.*?\]$/, "");
}

/** Escape special regex characters for literal matching. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

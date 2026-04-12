import type { StatKind } from "../stats/StatisticalUtils.ts";

/** Parsed spec for one timing column selected via --stats. */
export interface StatSpec {
  key: string;
  title: string;
  statKind: StatKind;
}

/** Parse --stats into column specs. Throws on empty/invalid tokens. */
export function parseStatsArg(stats: string): StatSpec[] {
  const tokens = stats
    .split(",")
    .map(t => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("--stats must list at least one column");
  }
  const seen = new Set<string>();
  const specs: StatSpec[] = [];
  for (const token of tokens) {
    const spec = parseStatToken(token);
    if (seen.has(spec.key)) continue;
    seen.add(spec.key);
    specs.push(spec);
  }
  return specs;
}

/** @return stat spec for a single --stats token. Throws on invalid input. */
function parseStatToken(token: string): StatSpec {
  const lower = token.toLowerCase();
  if (lower === "mean" || lower === "avg") {
    return { key: "mean", title: "mean", statKind: "mean" };
  }
  if (lower === "median") {
    return { key: "p50", title: "p50", statKind: { percentile: 0.5 } };
  }
  if (lower === "min") {
    return { key: "min", title: "min", statKind: "min" };
  }
  if (lower === "max") {
    return { key: "max", title: "max", statKind: "max" };
  }
  const m = lower.match(/^p(\d+)$/);
  if (m) return parsePercentileToken(token, m[1]);
  throw new Error(
    `invalid --stats token "${token}": expected mean, median, min, max, or p<N> (e.g. p50, p99, p999)`,
  );
}

/** @return spec for a p<N> token, enforcing the 2-digit minimum and 9-prefix rule. */
function parsePercentileToken(token: string, digits: string): StatSpec {
  if (digits.length < 2) {
    throw new Error(
      `invalid --stats token "${token}": percentile needs at least 2 digits (e.g. p05, p50, p99, p999)`,
    );
  }
  // 3+ digit tokens express sub-percentile precision (p999 = 99.9%,
  // p9999 = 99.99%). Require leading 9 so p100/p500 don't silently
  // map to 10%/50% — use 2-digit p10/p50 for those.
  if (digits.length > 2 && digits[0] !== "9") {
    throw new Error(
      `invalid --stats token "${token}": percentiles with 3+ digits must start with 9 (e.g. p999, p9999); otherwise use 2-digit form (e.g. p50)`,
    );
  }
  const q = Number(digits) / 10 ** digits.length;
  return {
    key: `p${digits}`,
    title: `p${digits}`,
    statKind: { percentile: q },
  };
}

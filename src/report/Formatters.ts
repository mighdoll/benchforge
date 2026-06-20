/** Format a time in milliseconds, picking ns/μs/ms/s and a precision that keeps
 *  ~2-3 significant figures. Sub-millisecond values read in μs so a tight CI
 *  stays distinguishable (e.g. "94μs", not a rounded-flat "0.09ms"). */
export function timeMs(ms: unknown): string | null {
  if (typeof ms !== "number") return null;
  if (ms < 0.001) return `${(ms * 1000000).toFixed(0)}ns`;
  if (ms < 1) {
    const us = ms * 1000;
    const precision = us < 10 ? 1 : 0;
    return `${us.toFixed(precision)}μs`;
  }
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 10) return `${ms.toFixed(0)}ms`;
  return `${ms.toFixed(2)}ms`;
}

/** Format integer with thousand separators */
export function integer(x: unknown): string | null {
  if (typeof x !== "number") return null;
  return new Intl.NumberFormat("en-US").format(Math.round(x));
}

/** Format fraction as percentage (0.473 ==> 47.3%) */
export function percent(fraction: unknown, precision = 1): string | null {
  if (typeof fraction !== "number") return null;
  return `${Math.abs(fraction * 100).toFixed(precision)}%`;
}

/** Format bytes with appropriate units. Use `space: true` for `1.5 KB` style. */
export function formatBytes(
  bytes: unknown,
  opts?: { space?: boolean },
): string | null {
  if (typeof bytes !== "number") return null;
  const s = opts?.space ? " " : "";
  const [kb, mb, gb] = [1024, 1024 ** 2, 1024 ** 3];
  if (bytes < kb) return `${bytes.toFixed(0)}${s}B`;
  if (bytes < mb) return `${(bytes / kb).toFixed(1)}${s}KB`;
  if (bytes < gb) return `${(bytes / mb).toFixed(1)}${s}MB`;
  return `${(bytes / gb).toFixed(1)}${s}GB`;
}

/** @return signed percentage string (e.g. "+1.2%", "-3.4%") */
export function formatSignedPercent(v: number, precision = 1): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(precision)}%`;
}

/** @return a signed-percent CI as "[+1.2%, +3.4%]". */
export function formatPercentCI(ci: [number, number], precision = 1): string {
  const [lo, hi] = ci.map(v => formatSignedPercent(v, precision));
  return `[${lo}, ${hi}]`;
}

/** Mark a run name as the baseline series for display. Idempotent: a name that
 *  already reads as the baseline ("baseline" or "...(baseline)") is returned
 *  unchanged; otherwise " (baseline)" is appended. Falls back to "baseline" when
 *  unnamed. */
export function baselineLabel(name?: string): string {
  if (!name || name === "baseline") return "baseline";
  return name.endsWith("(baseline)") ? name : `${name} (baseline)`;
}

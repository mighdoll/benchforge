import {
  type CIDirection,
  type DifferenceCI,
  flipCI,
} from "../stats/StatisticalUtils.ts";
import colors from "./Colors.ts";

const { red, green } = colors;

/** Format duration in milliseconds with appropriate units (ns, μs, ms, s) */
export function duration(ms: unknown): string | null {
  if (typeof ms !== "number") return null;
  if (ms < 0.001) return `${(ms * 1000000).toFixed(0)}ns`;
  if (ms < 1) return `${(ms * 1000).toFixed(1)}μs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Format time in milliseconds with appropriate units */
export function timeMs(ms: unknown): string | null {
  if (typeof ms !== "number") return null;
  if (ms < 0.001) return `${(ms * 1000000).toFixed(0)}ns`;
  if (ms < 0.01) return `${(ms * 1000).toFixed(1)}μs`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 10) return `${ms.toFixed(0)}ms`;
  return `${ms.toFixed(2)}ms`;
}

/** Format integer with thousand separators */
export function integer(x: unknown): string | null {
  if (typeof x !== "number") return null;
  return new Intl.NumberFormat("en-US").format(Math.round(x));
}

/** Format fraction as percentage (0.473 → 47.3%) */
export function percent(fraction: unknown, precision = 1): string | null {
  if (typeof fraction !== "number") return null;
  return `${Math.abs(fraction * 100).toFixed(precision)}%`;
}

/** Format percentage difference between two values */
export function diffPercent(main: unknown, base: unknown): string {
  if (typeof main !== "number" || typeof base !== "number") return " ";
  const diff = main - base;
  return coloredPercent(diff, base);
}

/** Format bytes with appropriate units (B, KB, MB, GB).
 *  Use `space: true` for human-readable console output (`1.5 KB`). */
export function formatBytes(
  bytes: unknown,
  opts?: { space?: boolean },
): string | null {
  if (typeof bytes !== "number") return null;
  const s = opts?.space ? " " : "";
  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;
  if (bytes < kb) return `${bytes.toFixed(0)}${s}B`;
  if (bytes < mb) return `${(bytes / kb).toFixed(1)}${s}KB`;
  if (bytes < gb) return `${(bytes / mb).toFixed(1)}${s}MB`;
  return `${(bytes / gb).toFixed(1)}${s}GB`;
}

/** Format percentage difference with confidence interval */
export function formatDiffWithCI(value: unknown): string | null {
  if (!isDifferenceCI(value)) return null;
  const { percent, ci, direction } = value;
  return colorByDirection(diffCIText(percent, ci), direction);
}

/** Format percentage difference with CI for throughput metrics (higher is better) */
export function formatDiffWithCIHigherIsBetter(value: unknown): string | null {
  if (!isDifferenceCI(value)) return null;
  const { percent, ci, direction } = flipCI(value);
  return colorByDirection(diffCIText(percent, ci), direction);
}

/** @return truncated string with ellipsis if over maxLen */
export function truncate(str: string, maxLen = 30): string {
  return str.length > maxLen ? str.slice(0, maxLen - 3) + "..." : str;
}

/** @return signed percentage string (e.g. "+1.2%", "-3.4%") */
export function formatSignedPercent(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

/** Format fraction as colored +/- percentage (positive = green, negative = red) */
function coloredPercent(numerator: number, denominator: number): string {
  const fraction = numerator / denominator;
  if (!Number.isFinite(fraction)) return " ";
  const sign = fraction >= 0 ? "+" : "-";
  const percentStr = `${sign}${percent(fraction)}`;
  return fraction >= 0 ? green(percentStr) : red(percentStr);
}

/** @return true if value is a DifferenceCI object */
function isDifferenceCI(x: unknown): x is DifferenceCI {
  return typeof x === "object" && x !== null && "ci" in x && "direction" in x;
}

/** @return text colored green for faster, red for slower */
function colorByDirection(text: string, direction: CIDirection): string {
  if (direction === "faster") return green(text);
  if (direction === "slower") return red(text);
  return text;
}

/** @return formatted "pct [lo, hi]" text for a diff with CI */
function diffCIText(pct: number, ci: [number, number]): string {
  const [lo, hi] = ci.map(formatSignedPercent);
  return `${formatSignedPercent(pct)} [${lo}, ${hi}]`;
}

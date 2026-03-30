import colors from "../Colors.ts";

const { red } = colors;

const lowConfidence = 80;

/** @return convergence percentage with color for low values */
export function formatConvergence(v: unknown): string {
  if (typeof v !== "number") return "—";
  const pct = `${Math.round(v)}%`;
  return v < lowConfidence ? red(pct) : pct;
}

/** @return coefficient of variation as ±percentage */
export function formatCV(v: unknown): string {
  if (typeof v !== "number") return "";
  return `±${(v * 100).toFixed(1)}%`;
}

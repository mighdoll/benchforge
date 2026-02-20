import pico from "picocolors";

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
const { red } = isTest ? { red: (str: string) => str } : pico;

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

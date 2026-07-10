import type { CIDirection } from "../stats/Bootstrap.ts";

/** @return the verdict word for a comparison direction. The direction already
 *  accounts for metric orientation (higherIsBetter flips it), so "faster"
 *  always means improved, for timing and throughput metrics alike. */
export function verdictWord(direction: CIDirection): string {
  if (direction === "uncertain") return "inconclusive";
  return direction;
}

/** @return the verdict word capitalized, for badges and popup headers. */
export function verdictLabel(direction: CIDirection): string {
  const word = verdictWord(direction);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

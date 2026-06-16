import type { CIDirection } from "../stats/Bootstrap.ts";

/** @return the verdict word for a comparison direction. The direction already
 *  accounts for metric orientation (higherIsBetter flips it), so "better" reads
 *  correctly for both timing and throughput metrics. */
export function verdictWord(direction: CIDirection): string {
  if (direction === "faster") return "better";
  if (direction === "slower") return "worse";
  if (direction === "equivalent") return "equivalent";
  return "uncertain";
}

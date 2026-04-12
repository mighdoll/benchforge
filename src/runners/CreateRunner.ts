import type { BenchRunner } from "./BenchRunner.ts";
import { TimingRunner } from "./TimingRunner.ts";

export type KnownRunner = "timing";

/** Create a benchmark runner by name. */
export async function createRunner(_name: KnownRunner): Promise<BenchRunner> {
  return new TimingRunner();
}

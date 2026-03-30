import { BasicRunner } from "./BasicRunner.ts";
import type { BenchRunner } from "./BenchRunner.ts";

export type KnownRunner = "basic";

/** Create a benchmark runner by name. */
export async function createRunner(
  _runnerName: KnownRunner,
): Promise<BenchRunner> {
  return new BasicRunner();
}

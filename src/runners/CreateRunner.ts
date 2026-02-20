import { BasicRunner } from "./BasicRunner.ts";
import type { BenchRunner } from "./BenchRunner.ts";

export type KnownRunner = "basic";

/** @return benchmark runner */
export async function createRunner(
  _runnerName: KnownRunner,
): Promise<BenchRunner> {
  return new BasicRunner();
}

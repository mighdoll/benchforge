import {
  type AdaptiveOptions,
  createAdaptiveWrapper,
} from "./AdaptiveWrapper.ts";
import type { BenchRunner, RunnerOptions } from "./BenchRunner.ts";
import { createRunner, type KnownRunner } from "./CreateRunner.ts";

export const msToNs = 1e6;

/** Get named or default export from module, throw if not a function */
// biome-ignore lint/complexity/noBannedTypes: generic function constraint
export function getModuleExport<T extends Function = Function>(
  module: any,
  exportName: string | undefined,
  modulePath: string,
): T {
  const fn = exportName ? module[exportName] : module.default || module;
  if (typeof fn !== "function") {
    const name = exportName || "default";
    throw new Error(`Export '${name}' from ${modulePath} is not a function`);
  }
  return fn as T;
}

/** Create runner, wrapping with adaptive sampling if options.adaptive is set */
export async function createBenchRunner(
  runnerName: KnownRunner,
  options: RunnerOptions,
): Promise<BenchRunner> {
  const base = await createRunner(runnerName);
  return (options as any).adaptive
    ? createAdaptiveWrapper(base, options as AdaptiveOptions)
    : base;
}

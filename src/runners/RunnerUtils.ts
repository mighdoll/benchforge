import { prepareBenchFn } from "../matrix/BenchMatrix.ts";
import { loadCaseData, loadCasesModule } from "../matrix/CaseLoader.ts";
import { loadVariant } from "../matrix/VariantLoader.ts";
import {
  type AdaptiveOptions,
  createAdaptiveWrapper,
} from "./AdaptiveWrapper.ts";
import type { BenchmarkFunction } from "./BenchmarkSpec.ts";
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

/** Import a benchmark function from a module, optionally running a setup export */
export async function importBenchFn(
  modulePath: string,
  exportName: string | undefined,
  setupExportName: string | undefined,
  params: unknown,
): Promise<{ fn: BenchmarkFunction; params: unknown }> {
  const module = await import(modulePath);
  const fn = getModuleExport<BenchmarkFunction>(module, exportName, modulePath);
  if (!setupExportName) return { fn, params };

  const setup = getModuleExport<BenchmarkFunction>(
    module,
    setupExportName,
    modulePath,
  );
  return { fn, params: await setup(params) };
}

/** Resolve a matrix variant to a benchmark function (shared by orchestrator and worker). */
export async function resolveVariantFn(params: {
  variantDir: string;
  variantId: string;
  caseId?: string;
  caseData?: unknown;
  casesModule?: string;
}): Promise<{ fn: BenchmarkFunction; params: undefined }> {
  let { caseData } = params;
  if (params.casesModule && params.caseId) {
    const cases = await loadCasesModule(params.casesModule);
    caseData = (await loadCaseData(cases, params.caseId)).data;
  }
  const variant = await loadVariant(params.variantDir, params.variantId);
  const fn = await prepareBenchFn(variant, caseData);
  return { fn, params: undefined };
}

/** Create runner, wrapping with adaptive sampling if options.adaptive is set */
export async function createBenchRunner(
  runnerName: KnownRunner,
  options: RunnerOptions,
): Promise<BenchRunner> {
  const base = await createRunner(runnerName);
  if ("adaptive" in options && options.adaptive) {
    return createAdaptiveWrapper(base, options as AdaptiveOptions);
  }
  return base;
}

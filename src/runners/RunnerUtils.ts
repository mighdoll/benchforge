import { prepareBenchFn, type Variant } from "../matrix/BenchMatrix.ts";
import { loadCaseData, loadCasesModule } from "../matrix/CaseLoader.ts";
import { loadVariant } from "../matrix/VariantLoader.ts";
import type { BenchmarkFunction } from "./BenchmarkSpec.ts";

/** Where a matrix variant's code comes from: a directory of .ts files (loaded
 *  by id, re-imported in the worker) or inline functions serialized to source
 *  (the run fn, plus a setup fn for stateful variants). Inline functions must be
 *  self-contained -- they are reconstructed by eval in the worker, so captured
 *  closure variables are not available. */
export type VariantSource =
  | { variantDir: string; variantId: string }
  | { runCode: string; setupCode?: string; variantId: string };

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

/** Resolve a matrix variant to a benchmark function (shared by orchestrator and
 *  worker). The variant comes from a directory module or from inline serialized
 *  code; case data comes from a cases module or is passed inline. */
export async function resolveVariantFn(params: {
  source: VariantSource;
  caseId?: string;
  caseData?: unknown;
  casesModule?: string;
}): Promise<{ fn: BenchmarkFunction; params: undefined }> {
  let { caseData } = params;
  if (params.casesModule && params.caseId) {
    const cases = await loadCasesModule(params.casesModule);
    caseData = (await loadCaseData(cases, params.caseId)).data;
  }
  const variant = await resolveVariant(params.source);
  const fn = await prepareBenchFn(variant, caseData);
  return { fn, params: undefined };
}

/** A variant from a directory module, or reconstructed from inline code. */
async function resolveVariant(source: VariantSource): Promise<Variant> {
  if ("variantDir" in source) {
    return loadVariant(source.variantDir, source.variantId);
  }
  const run = evalFn(source.runCode);
  if (!source.setupCode) return run as Variant;
  return { setup: evalFn(source.setupCode), run } as Variant;
}

/** Eval serialized function source back into a callable. */
function evalFn(code: string): (...args: unknown[]) => unknown {
  // biome-ignore lint/security/noGlobalEval: worker isolation; code is trusted (self-authored variant)
  const fn = eval(`(${code})`); // eslint-disable-line no-eval
  if (typeof fn !== "function")
    throw new Error("Variant code is not a function");
  return fn;
}

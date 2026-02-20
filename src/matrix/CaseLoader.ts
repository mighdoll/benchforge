import type { LoadedCase } from "../BenchMatrix.ts";

/** Module that exports case definitions */
export interface CasesModule<T = unknown> {
  cases: string[];
  defaultCases?: string[]; // subset for quick runs
  defaultVariants?: string[]; // subset for quick runs
  loadCase?: (id: string) => LoadedCase<T> | Promise<LoadedCase<T>>;
}

/** Load a cases module by URL */
export async function loadCasesModule<T = unknown>(
  moduleUrl: string,
): Promise<CasesModule<T>> {
  const module = await import(moduleUrl);
  if (!Array.isArray(module.cases)) {
    throw new Error(`Cases module at ${moduleUrl} must export 'cases' array`);
  }
  return {
    cases: module.cases,
    defaultCases: module.defaultCases,
    defaultVariants: module.defaultVariants,
    loadCase: module.loadCase,
  };
}

/** Load case data from a CasesModule or pass through the caseId */
export async function loadCaseData<T>(
  casesModule: CasesModule<T> | undefined,
  caseId: string,
): Promise<LoadedCase<T>> {
  if (casesModule?.loadCase) {
    return casesModule.loadCase(caseId);
  }
  return { data: caseId as T };
}

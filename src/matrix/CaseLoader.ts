import type { LoadedCase } from "./BenchMatrix.ts";

/** Module exporting case IDs and an optional loader for case data */
export interface CasesModule<T = unknown> {
  cases: string[];
  /** Subset of cases for quick runs */
  defaultCases?: string[];
  /** Subset of variants for quick runs */
  defaultVariants?: string[];
  loadCase?: (id: string) => LoadedCase<T> | Promise<LoadedCase<T>>;
}

/** Import and validate a cases module, which must export a `cases` array */
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

/** Load case data from a CasesModule, or use the caseId as data if no module */
export async function loadCaseData<T>(
  casesModule: CasesModule<T> | undefined,
  caseId: string,
): Promise<LoadedCase<T>> {
  if (casesModule?.loadCase) {
    return casesModule.loadCase(caseId);
  }
  return { data: caseId as T };
}

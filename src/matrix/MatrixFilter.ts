import type { BenchMatrix } from "./BenchMatrix.ts";
import { loadCasesModule } from "./CaseLoader.ts";
import { discoverVariants } from "./VariantLoader.ts";

/** Filter for matrix case/variant selection */
export interface MatrixFilter {
  case?: string;
  variant?: string;
}

/** Filtered matrix with explicit case and variant lists */
export interface FilteredMatrix<T = unknown> extends BenchMatrix<T> {
  filteredCases?: string[];
  filteredVariants?: string[];
}

/** Parse filter string: "case/variant", "case/", "/variant", or "case" */
export function parseMatrixFilter(filter: string): MatrixFilter {
  if (filter.includes("/")) {
    const [casePart, varPart] = filter.split("/", 2);
    return { case: casePart || undefined, variant: varPart || undefined };
  }
  return { case: filter };
}

/** Apply filter to a matrix, merging with existing filters via intersection */
export async function filterMatrix<T>(
  matrix: FilteredMatrix<T>,
  filter?: MatrixFilter,
): Promise<FilteredMatrix<T>> {
  if (!filter || (!filter.case && !filter.variant)) return matrix;

  const caseList = await getFilteredCases(matrix, filter.case);
  const variantList = await getFilteredVariants(matrix, filter.variant);

  const filteredCases = intersectFilters(caseList, matrix.filteredCases);
  const filteredVariants = intersectFilters(
    variantList,
    matrix.filteredVariants,
  );

  return { ...matrix, filteredCases, filteredVariants };
}

/** Collect all case IDs from either casesModule or inline cases */
export async function resolveCaseIds<T>(
  matrix: BenchMatrix<T>,
): Promise<string[] | undefined> {
  if (matrix.casesModule)
    return (await loadCasesModule(matrix.casesModule)).cases;
  return matrix.cases;
}

/** Collect all variant IDs from either inline variants or variantDir */
export async function resolveVariantIds<T>(
  matrix: BenchMatrix<T>,
): Promise<string[]> {
  if (matrix.variants) return Object.keys(matrix.variants);
  if (matrix.variantDir) return discoverVariants(matrix.variantDir);
  throw new Error("BenchMatrix requires 'variants' or 'variantDir'");
}

/** Return case IDs matching a substring pattern, or all if no pattern */
async function getFilteredCases<T>(
  matrix: BenchMatrix<T>,
  casePattern?: string,
): Promise<string[] | undefined> {
  if (!casePattern) return undefined;
  const caseIds = await resolveCaseIds(matrix);
  if (!caseIds) return ["default"]; // implicit single case
  return filterByPattern(caseIds, casePattern, "cases");
}

/** Return variant IDs matching a substring pattern, or all if no pattern */
async function getFilteredVariants<T>(
  matrix: BenchMatrix<T>,
  variantPattern?: string,
): Promise<string[] | undefined> {
  if (!variantPattern) return undefined;
  const allIds = await resolveVariantIds(matrix);
  return filterByPattern(allIds, variantPattern, "variants");
}

/** Intersect two optional filter lists: both present ==> intersection, otherwise the one that exists */
function intersectFilters(a?: string[], b?: string[]): string[] | undefined {
  if (a && b) return a.filter(v => b.includes(v));
  return a ?? b;
}

/** Filter IDs by substring pattern, throwing if no matches */
function filterByPattern(
  ids: string[],
  pattern: string,
  label: string,
): string[] {
  const filtered = ids.filter(id => matchPattern(id, pattern));
  if (filtered.length === 0)
    throw new Error(`No ${label} match filter: "${pattern}"`);
  return filtered;
}

/** Case-insensitive substring match */
function matchPattern(id: string, pattern: string): boolean {
  return id.toLowerCase().includes(pattern.toLowerCase());
}

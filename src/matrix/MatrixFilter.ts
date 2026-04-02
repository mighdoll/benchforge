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
    const [casePart, variantPart] = filter.split("/", 2);
    return {
      case: casePart || undefined,
      variant: variantPart || undefined,
    };
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

  const filteredCases =
    caseList && matrix.filteredCases
      ? caseList.filter(c => matrix.filteredCases!.includes(c))
      : (caseList ?? matrix.filteredCases);

  const filteredVariants =
    variantList && matrix.filteredVariants
      ? variantList.filter(v => matrix.filteredVariants!.includes(v))
      : (variantList ?? matrix.filteredVariants);

  return { ...matrix, filteredCases, filteredVariants };
}

/** Return case IDs matching a substring pattern, or all if no pattern */
async function getFilteredCases<T>(
  matrix: BenchMatrix<T>,
  casePattern?: string,
): Promise<string[] | undefined> {
  if (!casePattern) return undefined;

  const caseIds = await resolveCaseIds(matrix);
  if (!caseIds) return ["default"]; // implicit single case

  const filtered = caseIds.filter(id => matchPattern(id, casePattern));
  if (filtered.length === 0) {
    throw new Error(`No cases match filter: "${casePattern}"`);
  }
  return filtered;
}

/** Return variant IDs matching a substring pattern, or all if no pattern */
async function getFilteredVariants<T>(
  matrix: BenchMatrix<T>,
  variantPattern?: string,
): Promise<string[] | undefined> {
  if (!variantPattern) return undefined;

  const allIds = await resolveVariantIds(matrix);

  const filtered = allIds.filter(id => matchPattern(id, variantPattern));
  if (filtered.length === 0) {
    throw new Error(`No variants match filter: "${variantPattern}"`);
  }
  return filtered;
}

/** Case-insensitive substring match */
function matchPattern(id: string, pattern: string): boolean {
  return id.toLowerCase().includes(pattern.toLowerCase());
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

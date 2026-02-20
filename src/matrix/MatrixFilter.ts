import type { BenchMatrix } from "../BenchMatrix.ts";
import { loadCasesModule } from "./CaseLoader.ts";
import { discoverVariants } from "./VariantLoader.ts";

/** Filter for matrix case/variant selection */
export interface MatrixFilter {
  case?: string;
  variant?: string;
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

/** Filtered matrix with explicit case and variant lists */
export interface FilteredMatrix<T = unknown> extends BenchMatrix<T> {
  filteredCases?: string[];
  filteredVariants?: string[];
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

/** Get case IDs matching filter pattern */
async function getFilteredCases<T>(
  matrix: BenchMatrix<T>,
  casePattern?: string,
): Promise<string[] | undefined> {
  if (!casePattern) return undefined;

  const caseIds = matrix.casesModule
    ? (await loadCasesModule(matrix.casesModule)).cases
    : matrix.cases;
  if (!caseIds) return ["default"]; // implicit single case

  const filtered = caseIds.filter(id => matchPattern(id, casePattern));
  if (filtered.length === 0) {
    throw new Error(`No cases match filter: "${casePattern}"`);
  }
  return filtered;
}

/** Get variant IDs matching filter pattern */
async function getFilteredVariants<T>(
  matrix: BenchMatrix<T>,
  variantPattern?: string,
): Promise<string[] | undefined> {
  if (!variantPattern) return undefined;

  if (matrix.variants) {
    const ids = Object.keys(matrix.variants).filter(id =>
      matchPattern(id, variantPattern),
    );
    if (ids.length === 0) {
      throw new Error(`No variants match filter: "${variantPattern}"`);
    }
    return ids;
  }

  if (matrix.variantDir) {
    const allIds = await discoverVariants(matrix.variantDir);
    const filtered = allIds.filter(id => matchPattern(id, variantPattern));
    if (filtered.length === 0) {
      throw new Error(`No variants match filter: "${variantPattern}"`);
    }
    return filtered;
  }

  throw new Error("BenchMatrix requires 'variants' or 'variantDir'");
}

/** Match id against pattern (case-insensitive substring) */
function matchPattern(id: string, pattern: string): boolean {
  return id.toLowerCase().includes(pattern.toLowerCase());
}

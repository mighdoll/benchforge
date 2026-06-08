/** Serialized `.benchforge` archive format. */

import type { ReportData } from "../viewer/ReportData.ts";
import type { LineCoverage } from "./CoverageExport.ts";
import type { SpeedscopeFile } from "./SpeedscopeTypes.ts";

export interface BenchforgeArchive {
  /** Archive format version. */
  schema: number;

  /** Heap allocation profile in Speedscope format. */
  allocProfile?: SpeedscopeFile;

  /** CPU time profile in Speedscope format. */
  timeProfile?: SpeedscopeFile;

  /** Per-line coverage data keyed by source URL. */
  coverage?: Record<string, LineCoverage[]>;

  /** Benchmark report with suite results and statistics. */
  report?: ReportData;

  /** Source file contents keyed by file URL. */
  sources: Record<string, string>;

  /** Archive creation metadata. */
  metadata: ArchiveMetadata;
}

export interface ArchiveMetadata {
  /** ISO timestamp (colons/periods replaced with dashes for filename safety). */
  timestamp: string;

  /** Benchforge package version. */
  benchforgeVersion: string;
}

export const archiveSchemaVersion = 3;

/** Validate an archive's schema field against the supported version.
 *  @return an explanatory error message, or undefined when the schema matches. */
export function archiveSchemaError(schema: number): string | undefined {
  if (schema === archiveSchemaVersion) return undefined;
  const rel = schema > archiveSchemaVersion ? "newer than" : "older than";
  return (
    `Archive schema version ${schema} is ${rel} supported (${archiveSchemaVersion}). ` +
    "Regenerate the .benchforge archive with this version of benchforge."
  );
}

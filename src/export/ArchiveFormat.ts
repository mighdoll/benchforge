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

export const archiveSchemaVersion = 2;

/** Migrate a parsed archive from older schema versions to current. */
export function migrateArchive(
  raw: Record<string, unknown>,
): Partial<BenchforgeArchive> {
  const schema = (raw.schema as number) ?? 0;
  if (schema <= 1 && "profile" in raw && !("allocProfile" in raw)) {
    raw.allocProfile = raw.profile;
    delete raw.profile;
  }
  return raw as Partial<BenchforgeArchive>;
}

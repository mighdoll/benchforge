import { bootstrapDifferenceCI } from "../../stats/StatisticalUtils.ts";
import {
  type BenchmarkReport,
  extractSectionValues,
  isHigherIsBetter,
  type ReportColumnGroup,
  type ReportGroup,
  type ResultsMapper,
} from "../BenchmarkReport.ts";
import {
  formatDiffWithCI,
  formatDiffWithCIHigherIsBetter,
  truncate,
} from "../Formatters.ts";
import {
  buildTable,
  type ColumnGroup,
  type ResultGroup,
} from "./TableReport.ts";

type SectionStats<S> = S extends ResultsMapper<infer T> ? T : never;

interface ReportRowBase {
  name: string;
}

/** Row data combining all section statistics */
type ReportRowData<S extends ReadonlyArray<ResultsMapper<any>>> =
  ReportRowBase & UnionToIntersection<SectionStats<S[number]>>;

/** Convert union to intersection - https://mighdoll.dev/blog/modern-typescript-intersection/ */
type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (
  k: infer I extends U,
) => void
  ? I
  : never;

/** Build a formatted text table from benchmark groups, with baseline diff columns when present */
export function reportResults<S extends ReadonlyArray<ResultsMapper<any>>>(
  groups: ReportGroup[],
  sections: S,
): string {
  const results = groups.map(group => resultGroupValues(group, sections));
  const hasBaseline = results.some(g => g.baseline);
  return buildTable(createColumnGroups(sections, hasBaseline), results);
}

/** Extract stats from all sections into typed row objects for each report */
export function valuesForReports<S extends ReadonlyArray<ResultsMapper<any>>>(
  reports: BenchmarkReport[],
  sections: S,
): ReportRowData<S>[] {
  return reports.map(report => ({
    name: truncate(report.name),
    ...extractSectionValues(report.measuredResults, sections, report.metadata),
  })) as ReportRowData<S>[];
}

/** Insert a single "delta% CI" column after the first comparable column in each group */
export function injectDiffColumns<T>(
  reportGroups: ReportColumnGroup<T>[],
): ColumnGroup<T>[] {
  const ciFmt = isHigherIsBetter(reportGroups)
    ? formatDiffWithCIHigherIsBetter
    : formatDiffWithCI;
  const ciCol = { title: "Δ% CI", key: "diffCI" as keyof T, formatter: ciFmt };

  let ciAdded = false;
  return reportGroups.map(group => ({
    groupTitle: group.groupTitle,
    columns: group.columns.flatMap(col => {
      if (col.comparable && !ciAdded) {
        ciAdded = true;
        return [col, ciCol];
      }
      return [col];
    }),
  }));
}

/** Extract section stats and bootstrap CI diffs for all reports in a group */
function resultGroupValues<S extends ReadonlyArray<ResultsMapper<any>>>(
  group: ReportGroup,
  sections: S,
): ResultGroup<ReportRowData<S>> {
  const { reports, baseline } = group;
  const baseSamples = baseline?.measuredResults.samples;

  const results = reports.map(report => {
    const samples = report.measuredResults.samples;
    const diffCI =
      baseSamples && samples
        ? bootstrapDifferenceCI(baseSamples, samples)
        : undefined;

    return {
      name: truncate(report.name),
      ...extractSectionValues(
        report.measuredResults,
        sections,
        report.metadata,
      ),
      ...(diffCI && { diffCI }),
    } as ReportRowData<S>;
  });

  const baseRow = baseline && valuesForReports([baseline], sections)[0];
  return { results, baseline: baseRow };
}

/** Build table columns from sections, with name column and optional CI diff columns */
export function sectionColumnGroups<T extends { name: string }>(
  sections: ReadonlyArray<ResultsMapper<any>>,
  hasBaseline: boolean,
  nameTitle = "name",
): ColumnGroup<T>[] {
  const nameCol: ColumnGroup<T> = {
    columns: [{ key: "name" as keyof T, title: nameTitle }],
  };
  const groups = sections.flatMap(s => s.columns());
  return [
    nameCol,
    ...(hasBaseline ? injectDiffColumns(groups) : (groups as ColumnGroup<T>[])),
  ];
}

/** Build table columns from sections, injecting CI diff columns when baseline is present */
function createColumnGroups<S extends ReadonlyArray<ResultsMapper<any>>>(
  sections: S,
  hasBaseline: boolean,
): ColumnGroup<ReportRowData<S>>[] {
  return sectionColumnGroups<ReportRowData<S>>(sections, hasBaseline);
}

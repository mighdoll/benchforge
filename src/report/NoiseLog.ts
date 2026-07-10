/** Append-only log of the per-run noise floor. Every A/B run contributes a free
 *  A-vs-A noise sample (the baseline batches are all the same code), and a
 *  dedicated `--calibrate` run contributes a direct measurement; accumulating
 *  them builds a real-workload, per-machine history of the measurement noise
 *  floor. This first cut just writes the log -- trending it (passive margin
 *  calibration, "3x your median" anomaly flags) is a later reader of the file. */
import { appendFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { CalibrationResult } from "../runners/Calibration.ts";
import type { BenchmarkGroup, ReportData } from "../viewer/ReportData.ts";
import { marginArg } from "./CiFormatting.ts";
import { primaryMetricRow } from "./ConsoleSummary.ts";
import { verdictWord } from "./Verdict.ts";

/** One appended record. `kind` distinguishes a normal run's baseline readout
 *  from a dedicated calibrate measurement; the two define dispersion slightly
 *  differently (between-batch vs cross-run scatter), hence the discriminator. */
export interface NoiseLogRecord {
  timestamp: string;
  machine: string;
  kind: "ab" | "calibrate";
  benchmark: string;
  batches: number;

  /** Achieved resolution: baseline mean CI half-width, % of the mean. */
  halfWidthPct: number;

  /** Between-batch (ab) or cross-run (calibrate) dispersion, % of the mean. */
  dispersionPct: number;

  /** First-to-second-half baseline drift, % (ab only). */
  driftPct?: number;

  /** Lag-1 autocorrelation of baseline batch means (ab only). */
  crossRoundAcf?: number;

  /** equiv-margin in effect, or the suggested margin for a calibrate run. */
  equivMargin?: number;

  /** Case verdict word (ab only). */
  verdict?: string;

  /** Case delta %, current vs baseline (ab only). */
  deltaPct?: number;
}

const noiseLogFile = "noise-log.ndjson";

/** Append records as NDJSON to bench-report/noise-log.ndjson (the shared,
 *  gitignored output dir). Deliberately does not follow `--report-md`'s
 *  override: the log is a per-machine accumulating reference, not a copy of
 *  the run's report, so it stays put even when the report is redirected
 *  elsewhere. The log is auxiliary, so a write failure is swallowed -- it
 *  must never abort a run. */
export function appendNoiseLog(
  records: NoiseLogRecord[],
  dir = "bench-report",
): void {
  if (!records.length) return;
  try {
    mkdirSync(dir, { recursive: true });
    const body = records.map(r => JSON.stringify(r)).join("\n") + "\n";
    appendFileSync(join(dir, noiseLogFile), body);
  } catch {
    // auxiliary log; never fail the run over it
  }
}

/** This machine's id for the log. Hostname is good enough to separate laptops
 *  from CI runners; a slow noise regression on one machine trends on its own. */
export function machineId(): string {
  return hostname() || "unknown";
}

/** One record per case that has a noise floor (a baseline plus 2+ batches). */
export function abNoiseRecords(
  data: ReportData,
  machine: string,
): NoiseLogRecord[] {
  const { timestamp, cliArgs } = data.metadata;
  const margin = marginArg(cliArgs);
  return data.groups.flatMap(group => {
    const nf = group.noiseFloor;
    if (!nf) return [];
    const verdict = caseVerdict(group);
    return [
      {
        timestamp,
        machine,
        kind: "ab" as const,
        benchmark: group.name,
        batches: nf.batches,
        halfWidthPct: round(nf.halfWidthPct),
        dispersionPct: round(nf.dispersionPct),
        driftPct: round(nf.driftPct),
        crossRoundAcf: round(nf.crossRoundAcf),
        equivMargin: margin,
        verdict: verdict?.word,
        deltaPct: verdict ? round(verdict.percent) : undefined,
      },
    ];
  });
}

/** A calibrate run's record, from its own noise-floor summary (no per-case
 *  verdict -- a self-comparison reads "equivalent" by construction). */
export function calibrateNoiseRecord(
  result: CalibrationResult,
  timestamp: string,
  benchmark: string,
  machine: string,
): NoiseLogRecord {
  const { summary: s, batches } = result;
  return {
    timestamp,
    machine,
    kind: "calibrate",
    benchmark,
    batches,
    halfWidthPct: round(s.meanCiHalfWidth),
    dispersionPct: round(s.scatterStd),
    equivMargin: round(s.suggestedMargin),
  };
}

/** The case's verdict word and delta % from its primary metric's first
 *  comparison track, or undefined when the case has no baseline comparison. */
function caseVerdict(
  group: BenchmarkGroup,
): { word: string; percent: number } | undefined {
  const row = primaryMetricRow(group);
  const entry = row?.entries.find(e => !e.isBaseline && e.comparisonCI);
  const ci = entry?.comparisonCI;
  if (!ci) return undefined;
  return { word: verdictWord(ci.direction), percent: ci.percent };
}

/** Round to 3 decimals to keep the log compact (0.001% is ample resolution). */
function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

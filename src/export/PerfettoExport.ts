/** Export benchmark samples to Chrome Trace Event format for viewing in Perfetto. */

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanCliArgs, type DefaultCliArgs } from "../cli/CliArgs.ts";
import type { TraceEvent } from "../profiling/browser/ChromeTraceEvent.ts";
import type { ReportGroup } from "../report/BenchmarkReport.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";

interface TraceFile {
  traceEvents: TraceEvent[];
}

type Args = Record<string, unknown>;

const pid = 1;
const tid = 1;

/** Export benchmark results to Perfetto-compatible trace file */
export function exportPerfettoTrace(
  groups: ReportGroup[],
  outputPath: string,
  args: DefaultCliArgs,
): void {
  const absPath = resolve(outputPath);
  const events = buildTraceEvents(groups, args);

  const merged = mergeV8Trace(events);
  const traceFile: TraceFile = { traceEvents: merged };
  writeFileSync(absPath, JSON.stringify(traceFile));
  console.log(`Perfetto trace exported to: ${outputPath}`);

  scheduleDeferredMerge(absPath);
}

function buildTraceEvents(
  groups: ReportGroup[],
  cliArgs: DefaultCliArgs,
): TraceEvent[] {
  const metadata: TraceEvent[] = [
    meta("process_name", { name: "wesl-bench" }),
    meta("thread_name", { name: "MainThread" }),
    meta("bench_settings", cleanCliArgs(cliArgs)),
  ];

  const benchEvents = groups.flatMap(group =>
    group.reports.flatMap(report =>
      buildBenchmarkEvents(report.measuredResults as MeasuredResults),
    ),
  );

  return [...metadata, ...benchEvents];
}

function mergeV8Trace(events: TraceEvent[]): TraceEvent[] {
  const v8TracePath = readdirSync(".").find(
    f => f.startsWith("node_trace.") && f.endsWith(".log"),
  );
  const v8Events = loadV8Events(v8TracePath);
  const merged = v8Events ? [...v8Events, ...events] : events;
  normalizeTimestamps(merged);
  return merged;
}

/** V8 writes trace files after process exit, so we spawn a deferred merge. */
function scheduleDeferredMerge(outputPath: string): void {
  const cwd = process.cwd();
  const mergeScript = `
    const { readdirSync, readFileSync, writeFileSync } = require('fs');
    function normalize(events) {
      let min = Infinity;
      for (const e of events) if (e.ts > 0 && e.ts < min) min = e.ts;
      if (min === Infinity) return;
      for (const e of events) if (e.ts > 0) e.ts -= min;
    }
    setTimeout(() => {
      const traceFiles = readdirSync('.').filter(f => f.startsWith('node_trace.') && f.endsWith('.log'));
      if (traceFiles.length === 0) process.exit(0);
      try {
        const v8Data = JSON.parse(readFileSync(traceFiles[0], 'utf-8'));
        const ourData = JSON.parse(readFileSync('${outputPath}', 'utf-8'));
        const allEvents = [...v8Data.traceEvents, ...ourData.traceEvents];
        normalize(allEvents);
        writeFileSync('${outputPath}', JSON.stringify({ traceEvents: allEvents }));
        console.log('Merged ' + v8Data.traceEvents.length + ' V8 events into ' + '${outputPath}');
      } catch (e) { console.error('Merge failed:', e.message); }
    }, 100);
  `;

  process.on("exit", () => {
    const opts = { detached: true, stdio: "inherit" as const, cwd };
    spawn("node", ["-e", mergeScript], opts).unref();
  });
}

function meta(name: string, args: Args): TraceEvent {
  return { ph: "M", ts: 0, pid, tid, name, args };
}

/** Build events for a single benchmark run, deriving timestamps from cumulative sample durations. */
function buildBenchmarkEvents(results: MeasuredResults): TraceEvent[] {
  const { samples, heapSamples, pausePoints, startTime = 0 } = results;
  if (!samples?.length) return [];

  const timestamps = cumulativeTimestamps(samples, startTime);
  const events: TraceEvent[] = [];
  for (let i = 0; i < samples.length; i++) {
    const ts = timestamps[i];
    const ms = Math.round(samples[i] * 100) / 100;
    events.push(instant(ts, results.name, { n: i, ms }));
    events.push(counter(ts, "duration", { ms }));
    if (heapSamples?.[i] !== undefined) {
      const mb = Math.round((heapSamples[i] / 1024 / 1024) * 10) / 10;
      events.push(counter(ts, "heap", { MB: mb }));
    }
  }

  for (const pause of pausePoints ?? []) {
    const ts = timestamps[pause.sampleIndex];
    if (ts) events.push(instant(ts, "pause", { ms: pause.durationMs }));
  }
  return events;
}

function loadV8Events(
  v8TracePath: string | undefined,
): TraceEvent[] | undefined {
  if (!v8TracePath) return undefined;
  try {
    const v8Data = JSON.parse(readFileSync(v8TracePath, "utf-8")) as TraceFile;
    const { traceEvents } = v8Data;
    console.log(`Merged ${traceEvents.length} V8 events from ${v8TracePath}`);
    return traceEvents;
  } catch {
    console.warn(`Could not parse V8 trace file: ${v8TracePath}`);
    return undefined;
  }
}

/** Normalize timestamps so events start at 0 */
function normalizeTimestamps(events: TraceEvent[]): void {
  let min = Number.POSITIVE_INFINITY;
  for (const e of events) if (e.ts > 0 && e.ts < min) min = e.ts;
  if (min === Number.POSITIVE_INFINITY) return;
  for (const e of events) if (e.ts > 0) e.ts -= min;
}

/** Derive μs timestamps from cumulative sample durations (ms), offset by startTime. */
function cumulativeTimestamps(samples: number[], offset = 0): number[] {
  const timestamps = new Array<number>(samples.length);
  let cumulative = 0;
  for (let i = 0; i < samples.length; i++) {
    cumulative += samples[i];
    timestamps[i] = offset + Math.round(cumulative * 1000); // ms ==> μs
  }
  return timestamps;
}

/** Create a thread-scoped instant event */
function instant(ts: number, name: string, args: Args): TraceEvent {
  return { ph: "i", ts, pid, tid, cat: "bench", name, s: "t", args };
}

/** Create a counter event (shown as a time-series chart in Perfetto) */
function counter(ts: number, name: string, args: Args): TraceEvent {
  return { ph: "C", ts, pid, tid, cat: "bench", name, args };
}

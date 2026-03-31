import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DefaultCliArgs } from "../cli/CliArgs.ts";
import type { ReportGroup } from "../report/BenchmarkReport.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";

/** Chrome Trace Event format event */
interface TraceEvent {
  ph: string; // event type: M=metadata, C=counter, i=instant, B/E=begin/end
  ts: number; // timestamp in microseconds
  pid?: number;
  tid?: number;
  cat?: string;
  name: string;
  args?: Record<string, unknown>;
  s?: string; // scope for instant events: "t"=thread, "p"=process, "g"=global
  dur?: number; // duration for complete events
}

/** Chrome Trace Event format file structure */
interface TraceFile {
  traceEvents: TraceEvent[];
}

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
  writeTraceFile(absPath, merged);
  console.log(`Perfetto trace exported to: ${outputPath}`);

  // V8 writes trace files after process exit, so spawn a child to merge later
  scheduleDeferredMerge(absPath);
}

/** Build trace events from benchmark results */
function buildTraceEvents(
  groups: ReportGroup[],
  cliArgs: DefaultCliArgs,
): TraceEvent[] {
  const meta = (name: string, args: Record<string, unknown>): TraceEvent => ({
    ph: "M",
    ts: 0,
    pid,
    tid,
    name,
    args,
  });
  const metadata: TraceEvent[] = [
    meta("process_name", { name: "wesl-bench" }),
    meta("thread_name", { name: "MainThread" }),
    meta("bench_settings", cleanArgs(cliArgs)),
  ];

  const benchEvents = groups.flatMap(group =>
    group.reports.flatMap(report =>
      buildBenchmarkEvents(report.measuredResults as MeasuredResults),
    ),
  );

  return [...metadata, ...benchEvents];
}

/** Merge V8 trace events from a previous run, aligning timestamps */
function mergeV8Trace(events: TraceEvent[]): TraceEvent[] {
  const files = readdirSync(".").filter(
    f => f.startsWith("node_trace.") && f.endsWith(".log"),
  );
  const v8Events = loadV8Events(files[0]);
  normalizeTimestamps(events);
  if (!v8Events) return events;
  normalizeTimestamps(v8Events);
  return [...v8Events, ...events];
}

/** Write trace events to JSON file */
function writeTraceFile(outputPath: string, events: TraceEvent[]): void {
  const traceFile: TraceFile = { traceEvents: events };
  writeFileSync(outputPath, JSON.stringify(traceFile));
}

/** Spawn a detached child to merge V8 trace after process exit */
function scheduleDeferredMerge(outputPath: string): void {
  const cwd = process.cwd();
  const mergeScript = `
    const { readdirSync, readFileSync, writeFileSync } = require('fs');
    function normalize(events) {
      const times = events.filter(e => e.ts > 0).map(e => e.ts);
      if (!times.length) return;
      const min = Math.min(...times);
      for (const e of events) if (e.ts > 0) e.ts -= min;
    }
    setTimeout(() => {
      const traceFiles = readdirSync('.').filter(f => f.startsWith('node_trace.') && f.endsWith('.log'));
      if (traceFiles.length === 0) process.exit(0);
      try {
        const v8Data = JSON.parse(readFileSync(traceFiles[0], 'utf-8'));
        const ourData = JSON.parse(readFileSync('${outputPath}', 'utf-8'));
        normalize(v8Data.traceEvents);
        const merged = { traceEvents: [...v8Data.traceEvents, ...ourData.traceEvents] };
        writeFileSync('${outputPath}', JSON.stringify(merged));
        console.log('Merged ' + v8Data.traceEvents.length + ' V8 events into ' + '${outputPath}');
      } catch (e) { console.error('Merge failed:', e.message); }
    }, 100);
  `;

  process.on("exit", () => {
    const child = spawn("node", ["-e", mergeScript], {
      detached: true,
      stdio: "inherit",
      cwd,
    });
    child.unref();
  });
}

/** Clean CLI args for metadata */
function cleanArgs(args: DefaultCliArgs): Record<string, unknown> {
  const skip = new Set(["_", "$0"]);
  return Object.fromEntries(
    Object.entries(args).filter(([k, v]) => v !== undefined && !skip.has(k)),
  );
}

/** Build events for a single benchmark run */
function buildBenchmarkEvents(results: MeasuredResults): TraceEvent[] {
  const { samples, heapSamples, timestamps, pausePoints } = results;
  if (!timestamps?.length) return [];

  const events: TraceEvent[] = [];
  for (let i = 0; i < samples.length; i++) {
    const ts = timestamps[i];
    const ms = Math.round(samples[i] * 100) / 100;
    events.push(
      instant(ts, results.name, { n: i, ms }),
      counter(ts, "duration", { ms }),
    );
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

/** Load V8 trace events from file, or undefined if unavailable */
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
  const times = events.filter(e => e.ts > 0).map(e => e.ts);
  if (!times.length) return;
  const min = Math.min(...times);
  for (const e of events) if (e.ts > 0) e.ts -= min;
}

/** Create a thread-scoped instant event */
function instant(
  ts: number,
  name: string,
  args: Record<string, unknown>,
): TraceEvent {
  return { ph: "i", ts, pid, tid, cat: "bench", name, s: "t", args };
}

/** Create a counter event (shown as a time-series chart in Perfetto) */
function counter(
  ts: number,
  name: string,
  args: Record<string, unknown>,
): TraceEvent {
  return { ph: "C", ts, pid, tid, cat: "bench", name, args };
}

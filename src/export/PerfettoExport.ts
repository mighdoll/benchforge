import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReportGroup } from "../BenchmarkReport.ts";
import type { DefaultCliArgs } from "../cli/CliArgs.ts";
import type { MeasuredResults } from "../MeasuredResults.ts";

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

  // Try to merge any existing V8 trace from a previous run
  const merged = mergeV8Trace(events);
  writeTraceFile(absPath, merged);
  console.log(`Perfetto trace exported to: ${outputPath}`);

  // V8 writes trace files after process exit, so spawn a child to merge later
  scheduleDeferredMerge(absPath);
}

/** Build trace events from benchmark results */
function buildTraceEvents(
  groups: ReportGroup[],
  args: DefaultCliArgs,
): TraceEvent[] {
  const meta = (name: string, a: Record<string, unknown>): TraceEvent => ({
    ph: "M",
    ts: 0,
    pid,
    tid,
    name,
    args: a,
  });
  const events: TraceEvent[] = [
    meta("process_name", { name: "wesl-bench" }),
    meta("thread_name", { name: "MainThread" }),
    meta("bench_settings", cleanArgs(args)),
  ];

  for (const group of groups) {
    for (const report of group.reports) {
      const results = report.measuredResults as MeasuredResults;
      events.push(...buildBenchmarkEvents(results));
    }
  }

  return events;
}

function instant(
  ts: number,
  name: string,
  args: Record<string, unknown>,
): TraceEvent {
  return { ph: "i", ts, pid, tid, cat: "bench", name, s: "t", args };
}

function counter(
  ts: number,
  name: string,
  args: Record<string, unknown>,
): TraceEvent {
  return { ph: "C", ts, pid, tid, cat: "bench", name, args };
}

/** Build events for a single benchmark run */
function buildBenchmarkEvents(results: MeasuredResults): TraceEvent[] {
  const { samples, heapSamples, timestamps, pausePoints } = results;
  if (!timestamps?.length) return [];

  const events: TraceEvent[] = [];
  for (let i = 0; i < samples.length; i++) {
    const ts = timestamps[i];
    const ms = Math.round(samples[i] * 100) / 100;
    events.push(instant(ts, results.name, { n: i, ms }));
    events.push(counter(ts, "duration", { ms }));
    if (heapSamples?.[i] !== undefined) {
      const MB = Math.round((heapSamples[i] / 1024 / 1024) * 10) / 10;
      events.push(counter(ts, "heap", { MB }));
    }
  }

  for (const pause of pausePoints ?? []) {
    const ts = timestamps[pause.sampleIndex];
    if (ts) events.push(instant(ts, "pause", { ms: pause.durationMs }));
  }
  return events;
}

/** Normalize timestamps so events start at 0 */
function normalizeTimestamps(events: TraceEvent[]): void {
  const times = events.filter(e => e.ts > 0).map(e => e.ts);
  if (times.length === 0) return;
  const minTs = Math.min(...times);
  for (const e of events) if (e.ts > 0) e.ts -= minTs;
}

/** Merge V8 trace events from a previous run, aligning timestamps */
function mergeV8Trace(customEvents: TraceEvent[]): TraceEvent[] {
  const traceFiles = readdirSync(".").filter(
    f => f.startsWith("node_trace.") && f.endsWith(".log"),
  );

  const v8Events = loadV8Events(traceFiles[0]);
  normalizeTimestamps(customEvents);
  if (!v8Events) return customEvents;

  normalizeTimestamps(v8Events);
  return [...v8Events, ...customEvents];
}

/** Load V8 trace events from file, or undefined if unavailable */
function loadV8Events(
  v8TracePath: string | undefined,
): TraceEvent[] | undefined {
  if (!v8TracePath) return undefined;
  try {
    const v8Data = JSON.parse(readFileSync(v8TracePath, "utf-8")) as TraceFile;
    console.log(
      `Merged ${v8Data.traceEvents.length} V8 events from ${v8TracePath}`,
    );
    return v8Data.traceEvents;
  } catch {
    console.warn(`Could not parse V8 trace file: ${v8TracePath}`);
    return undefined;
  }
}

/** Write trace events to JSON file */
function writeTraceFile(outputPath: string, events: TraceEvent[]): void {
  const traceFile: TraceFile = { traceEvents: events };
  writeFileSync(outputPath, JSON.stringify(traceFile));
}

/** Clean CLI args for metadata */
function cleanArgs(args: DefaultCliArgs): Record<string, unknown> {
  const skip = new Set(["_", "$0"]);
  const entries = Object.entries(args).filter(
    ([k, v]) => v !== undefined && !skip.has(k),
  );
  return Object.fromEntries(entries);
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

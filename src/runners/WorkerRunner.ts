import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CoverageData } from "../profiling/node/CoverageTypes.ts";
import type { HeapProfile } from "../profiling/node/HeapSampler.ts";
import type { TimeProfile } from "../profiling/node/TimeSampler.ts";
import type { RunnerOptions } from "./BenchRunner.ts";
import {
  aggregateGcStats,
  fullGcEvents,
  type GcEvent,
  parseGcLine,
  shiftGcOffset,
} from "./GcStats.ts";
import type { MeasuredResults } from "./MeasuredResults.ts";
import type {
  ErrorMessage,
  ResultMessage,
  RunMessage,
} from "./WorkerScript.ts";

/** Run a benchmark in an isolated worker process with timeout and GC capture. */
export function runWorkerWithMessage(
  name: string,
  options: RunnerOptions,
  message: RunMessage,
): Promise<MeasuredResults[]> {
  const collectGcStats = options.gcStats ?? false;

  return new Promise((resolve, reject) => {
    const gcEvents: GcEvent[] = [];
    const worker = spawnWorkerProcess(collectGcStats);
    if (collectGcStats && worker.stdout) setupGcCapture(worker, gcEvents);

    const timeoutId = setTimeout(() => {
      killWorker();
      reject(new Error(`Benchmark "${name}" timed out after 60 seconds`));
    }, 60000);

    function killWorker() {
      clearTimeout(timeoutId);
      if (!worker.killed) worker.kill("SIGTERM");
    }

    worker.on("message", (msg: ResultMessage | ErrorMessage) => {
      killWorker();
      if (msg.type === "error") {
        const error = new Error(`Benchmark "${name}" failed: ${msg.error}`);
        if (msg.stack) error.stack = msg.stack;
        return reject(error);
      }
      const { results, heapProfile, timeProfile, coverage } = msg;
      attachProfilingData(
        results,
        gcEvents,
        heapProfile,
        timeProfile,
        coverage,
      );
      resolve(results);
    });
    worker.on("error", (error: Error) => {
      killWorker();
      const msg = `Worker process failed for "${name}": ${error.message}`;
      reject(new Error(msg));
    });
    worker.on("exit", (code: number | null) => {
      if (code !== 0 && code !== null) {
        killWorker();
        reject(new Error(`Worker exited with code ${code} for "${name}"`));
      }
    });

    worker.send(message);
  });
}

/** Spawn worker process with V8 flags */
function spawnWorkerProcess(gcStats: boolean) {
  const workerPath = resolveWorkerPath();
  const execArgv = ["--expose-gc", "--allow-natives-syntax"];
  if (gcStats) execArgv.push("--trace-gc-nvp");

  const env = { ...process.env, NODE_OPTIONS: "" };
  // silent mode captures stdout so we can parse --trace-gc-nvp output
  return fork(workerPath, [], {
    execArgv,
    silent: gcStats,
    env,
    serialization: "advanced",
  });
}

/** Capture and parse GC lines from worker stdout (--trace-gc-nvp). */
function setupGcCapture(worker: ChildProcess, gcEvents: GcEvent[]): void {
  let buffer = "";
  worker.stdout!.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const event = parseGcLine(line);
      if (event) gcEvents.push(event);
      else if (line.trim()) process.stdout.write(line + "\n");
    }
  });
}

/** Attach profiling data collected by the worker to each result. The GC
 *  aggregate and per-event array both count only in-loop events; warmup and
 *  import GCs (before loop start) and teardown GCs (after loop end, e.g.
 *  during result/profile collection) are excluded so the GC summary reflects
 *  the measured iterations, not setup or teardown. */
function attachProfilingData(
  results: MeasuredResults[],
  gcEvents: GcEvent[] | undefined,
  heapProfile?: HeapProfile,
  timeProfile?: TimeProfile,
  coverage?: CoverageData,
): void {
  const attach = <K extends keyof MeasuredResults>(
    key: K,
    value: MeasuredResults[K] | undefined,
  ) => {
    if (value) for (const r of results) r[key] = value;
  };
  attach("heapProfile", heapProfile);
  attach("timeProfile", timeProfile);
  attach("coverage", coverage);
  // GC offsets are process-start-relative; rebase per result to loop time so
  // they share the sample timeline, then drop out-of-loop events.
  if (!gcEvents?.length) return;
  for (const r of results) {
    const loopEvents = loopGcEvents(gcEvents, r.loopStartTime, r.loopEndTime);
    r.gcStats = loopEvents.length ? aggregateGcStats(loopEvents) : undefined;
    // Store only full GCs; the aggregate above keeps exact young-gen counts.
    const full = fullGcEvents(loopEvents);
    r.gcEvents = full.length ? full : undefined;
  }
}

/** Resolve WorkerScript path for dev (.ts) or dist (.mjs) */
function resolveWorkerPath(): string {
  const dir = import.meta.dirname!;
  const tsPath = path.join(dir, "WorkerScript.ts");
  if (existsSync(tsPath)) return tsPath;
  return path.join(dir, "runners", "WorkerScript.mjs");
}

/** Rebase GC offsets to loop-relative time and keep only in-loop events
 *  (0 <= offset <= loop duration). Without a loop anchor we can't tell warmup
 *  from loop, so keep all (offsets dropped, since they can't be placed on the
 *  sample timeline); without an end anchor, clamp the start only. */
function loopGcEvents(
  gcEvents: GcEvent[],
  loopStartTime: number | undefined,
  loopEndTime: number | undefined,
): GcEvent[] {
  if (loopStartTime === undefined) return gcEvents.map(stripOffset);
  const loopMs =
    loopEndTime === undefined
      ? Number.POSITIVE_INFINITY
      : loopEndTime - loopStartTime;
  const rebased = gcEvents.map(e => shiftGcOffset(e, -loopStartTime));
  return rebased.filter(
    e => e.offset === undefined || (e.offset >= 0 && e.offset <= loopMs),
  );
}

/** Drop the offset (unanchored, so not placeable on the sample timeline). */
function stripOffset(e: GcEvent): GcEvent {
  const { offset: _drop, ...rest } = e;
  return rest;
}

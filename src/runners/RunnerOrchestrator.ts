import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CoverageData } from "../profiling/node/CoverageTypes.ts";
import type { HeapProfile } from "../profiling/node/HeapSampler.ts";
import type { TimeProfile } from "../profiling/node/TimeSampler.ts";
import type { BenchmarkFunction, BenchmarkSpec } from "./BenchmarkSpec.ts";
import type { RunnerOptions } from "./BenchRunner.ts";
import { aggregateGcStats, type GcEvent, parseGcLine } from "./GcStats.ts";
import type { MeasuredResults } from "./MeasuredResults.ts";
import {
  importBenchFn,
  resolveVariantFn,
  type VariantSource,
} from "./RunnerUtils.ts";
import { TimingRunner } from "./TimingRunner.ts";
import type {
  ErrorMessage,
  ResultMessage,
  RunMessage,
} from "./WorkerScript.ts";

/** Parameters for running a matrix variant */
export interface RunMatrixVariantParams {
  source: VariantSource;
  caseId: string;
  caseData?: unknown;
  casesModule?: string;
  options: RunnerOptions;
  useWorker?: boolean;
}

interface RunBenchmarkParams<T = unknown> {
  spec: BenchmarkSpec<T>;
  options: RunnerOptions;
  useWorker?: boolean;
  params?: T;
}

/** Run a benchmark spec, optionally in an isolated worker process for profiling support. */
export async function runBenchmark<T = unknown>({
  spec,
  options,
  useWorker = false,
  params,
}: RunBenchmarkParams<T>): Promise<MeasuredResults[]> {
  if (!useWorker) {
    const resolved = spec.modulePath
      ? await resolveModuleSpec(spec, params)
      : { spec, params };
    return new TimingRunner().runBench(resolved.spec, options, resolved.params);
  }

  const msg = createRunMessage(spec, options, params);
  return runWorkerWithMessage(spec.name, options, msg);
}

/** Run a matrix variant benchmark, directly or in a worker. */
export async function runMatrixVariant(
  params: RunMatrixVariantParams,
): Promise<MeasuredResults[]> {
  const { source, caseId, caseData, casesModule, options } = params;
  const { useWorker = true } = params;
  const name = `${source.variantId}/${caseId}`;

  if (!useWorker) return runMatrixVariantDirect(params, name);

  const message: RunMessage = {
    type: "run",
    spec: { name } as BenchmarkSpec,
    options,
    caseId,
    caseData,
    casesModule,
    ...("variantDir" in source
      ? { variantDir: source.variantDir, variantId: source.variantId }
      : { variantRunCode: source.runCode, variantSetupCode: source.setupCode }),
  };
  return runWorkerWithMessage(name, options, message);
}

/** Resolve modulePath/exportName to a real function for non-worker mode */
async function resolveModuleSpec<T>(
  spec: BenchmarkSpec<T>,
  params: T | undefined,
): Promise<{ spec: BenchmarkSpec<T>; params: T | undefined }> {
  const { modulePath, exportName, setupExportName } = spec;
  const imported = await importBenchFn(
    modulePath!,
    exportName,
    setupExportName,
    params,
  );
  const fn = imported.fn as BenchmarkFunction<T>;
  return { spec: { ...spec, fn }, params: imported.params as T | undefined };
}

/** Serialize a BenchmarkSpec into a worker-safe message (modulePath or fnCode) */
function createRunMessage<T>(
  spec: BenchmarkSpec<T>,
  options: RunnerOptions,
  params?: T,
): RunMessage {
  const { fn, ...rest } = spec;
  const message: RunMessage = {
    type: "run",
    spec: rest as BenchmarkSpec,
    options,
    params,
  };
  if (spec.modulePath) {
    message.modulePath = spec.modulePath;
    message.exportName = spec.exportName;
    if (spec.setupExportName) message.setupExportName = spec.setupExportName;
  } else {
    message.fnCode = fn.toString();
  }
  return message;
}

/** Run a benchmark in an isolated worker process with timeout and GC capture. */
function runWorkerWithMessage(
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

/** Run matrix variant in-process (no worker isolation) */
async function runMatrixVariantDirect(
  params: RunMatrixVariantParams,
  name: string,
): Promise<MeasuredResults[]> {
  const { source, caseId, caseData, casesModule, options } = params;
  const { fn } = await resolveVariantFn({
    source,
    caseId,
    caseData,
    casesModule,
  });
  return new TimingRunner().runBench({ name, fn }, options);
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
 *  import GCs (offsets before loop start) are excluded so the GC summary
 *  reflects the measured iterations, not setup. */
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
  // they share the sample timeline, then drop pre-loop (warmup/import) events.
  if (!gcEvents?.length) return;
  for (const r of results) {
    const loopEvents = loopGcEvents(gcEvents, r.loopStartTime);
    r.gcEvents = loopEvents;
    r.gcStats = loopEvents.length ? aggregateGcStats(loopEvents) : undefined;
  }
}

/** Resolve WorkerScript path for dev (.ts) or dist (.mjs) */
function resolveWorkerPath(): string {
  const dir = import.meta.dirname!;
  const tsPath = path.join(dir, "WorkerScript.ts");
  if (existsSync(tsPath)) return tsPath;
  return path.join(dir, "runners", "WorkerScript.mjs");
}

/** Rebase GC offsets to loop-relative time and keep only in-loop events.
 *  Without a loop anchor we can't tell warmup from loop, so keep all (offsets
 *  dropped, since they can't be placed on the sample timeline). */
function loopGcEvents(
  gcEvents: GcEvent[],
  loopStartTime: number | undefined,
): GcEvent[] {
  if (loopStartTime === undefined) return gcEvents.map(stripOffset);
  const rebased = gcEvents.map(e =>
    e.offset === undefined ? e : { ...e, offset: e.offset - loopStartTime },
  );
  return rebased.filter(e => e.offset === undefined || e.offset >= 0);
}

/** Drop the offset (unanchored, so not placeable on the sample timeline). */
function stripOffset(e: GcEvent): GcEvent {
  const { offset: _drop, ...rest } = e;
  return rest;
}

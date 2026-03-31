import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CoverageData } from "../profiling/node/CoverageTypes.ts";
import type { HeapProfile } from "../profiling/node/HeapSampler.ts";
import type { TimeProfile } from "../profiling/node/TimeSampler.ts";
import type { BenchmarkFunction, BenchmarkSpec } from "./BenchmarkSpec.ts";
import type { RunnerOptions } from "./BenchRunner.ts";
import type { KnownRunner } from "./CreateRunner.ts";
import { aggregateGcStats, type GcEvent, parseGcLine } from "./GcStats.ts";
import type { MeasuredResults } from "./MeasuredResults.ts";
import { createBenchRunner, importBenchFn } from "./RunnerUtils.ts";
import { debugWorkerTiming, getElapsed, getPerfNow } from "./TimingUtils.ts";
import type {
  ErrorMessage,
  ResultMessage,
  RunMessage,
} from "./WorkerScript.ts";

/** Parameters for running a matrix variant in worker */
export interface RunMatrixVariantParams {
  variantDir: string;
  variantId: string;
  caseId: string;
  caseData?: unknown;
  casesModule?: string;
  runner: KnownRunner;
  options: RunnerOptions;
}

interface RunBenchmarkParams<T = unknown> {
  spec: BenchmarkSpec<T>;
  runner: KnownRunner;
  options: RunnerOptions;
  useWorker?: boolean;
  params?: T;
}

const logTiming = debugWorkerTiming
  ? (message: string) => console.log(`[RunnerOrchestrator] ${message}`)
  : () => {};

/** Execute benchmarks directly or in worker process */
export async function runBenchmark<T = unknown>({
  spec,
  runner,
  options,
  useWorker = false,
  params,
}: RunBenchmarkParams<T>): Promise<MeasuredResults[]> {
  if (!useWorker) {
    const resolved = spec.modulePath
      ? await resolveModuleSpec(spec, params)
      : { spec, params };
    const benchRunner = await createBenchRunner(runner, options);
    return benchRunner.runBench(resolved.spec, options, resolved.params);
  }

  const msg = createRunMessage(spec, runner, options, params);
  return runWorkerWithMessage(spec.name, options, msg);
}

/** Run a matrix variant benchmark in isolated worker process */
export async function runMatrixVariant(
  params: RunMatrixVariantParams,
): Promise<MeasuredResults[]> {
  const { variantId, caseId, runner, options } = params;
  const name = `${variantId}/${caseId}`;
  const message: RunMessage = {
    type: "run",
    spec: { name, fn: () => {} },
    runnerName: runner,
    options,
    variantDir: params.variantDir,
    variantId,
    caseId,
    caseData: params.caseData,
    casesModule: params.casesModule,
  };
  return runWorkerWithMessage(name, options, message);
}

/** Resolve modulePath/exportName to a real function for non-worker mode */
async function resolveModuleSpec<T>(
  spec: BenchmarkSpec<T>,
  params: T | undefined,
): Promise<{ spec: BenchmarkSpec<T>; params: T | undefined }> {
  const { modulePath, exportName, setupExportName } = spec;
  const r = await importBenchFn(
    modulePath!,
    exportName,
    setupExportName,
    params,
  );
  return {
    spec: { ...spec, fn: r.fn as BenchmarkFunction<T> },
    params: r.params as T | undefined,
  };
}

/** Create message for worker execution */
function createRunMessage<T>(
  spec: BenchmarkSpec<T>,
  runnerName: KnownRunner,
  options: RunnerOptions,
  params?: T,
): RunMessage {
  const { fn, ...rest } = spec;
  const message: RunMessage = {
    type: "run",
    spec: rest as BenchmarkSpec,
    runnerName,
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

/** Spawn worker, wire handlers, send message, return results */
function runWorkerWithMessage(
  name: string,
  options: RunnerOptions,
  message: RunMessage,
): Promise<MeasuredResults[]> {
  const startTime = getPerfNow();
  const collectGcStats = options.gcStats ?? false;
  logTiming(`Starting worker for ${name}`);

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
      if (msg.type === "result") {
        const elapsed = getElapsed(startTime).toFixed(1);
        logTiming(`Total worker time for ${name}: ${elapsed}ms`);
        const { results, heapProfile, timeProfile, coverage } = msg;
        attachProfilingData(
          results,
          gcEvents,
          heapProfile,
          timeProfile,
          coverage,
        );
        resolve(results);
      } else if (msg.type === "error") {
        const error = new Error(`Benchmark "${name}" failed: ${msg.error}`);
        if (msg.stack) error.stack = msg.stack;
        reject(error);
      }
    });
    worker.on("error", (error: Error) => {
      killWorker();
      const reason = `Worker process failed for "${name}"`;
      reject(new Error(`${reason}: ${error.message}`));
    });
    worker.on("exit", (code: number | null) => {
      if (code !== 0 && code !== null) {
        killWorker();
        const msg = `Worker exited with code ${code}`;
        reject(new Error(`${msg} for benchmark "${name}"`));
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
  return fork(workerPath, [], {
    execArgv,
    silent: gcStats, // Capture stdout/stderr when collecting GC stats
    env,
  });
}

/** Capture and parse GC lines from stdout (V8's --trace-gc-nvp outputs to stdout) */
function setupGcCapture(worker: ChildProcess, gcEvents: GcEvent[]): void {
  let buffer = "";
  worker.stdout!.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // Keep incomplete line in buffer
    for (const line of lines) {
      const event = parseGcLine(line);
      if (event) {
        gcEvents.push(event);
      } else if (line.trim()) {
        // Forward non-GC stdout to console (worker status messages)
        process.stdout.write(line + "\n");
      }
    }
  });
}

// Consider: --no-compilation-cache, --max-old-space-size=512, --no-lazy
// for consistency (less realistic)

/** Attach profiling data to all results in a batch */
function attachProfilingData(
  results: MeasuredResults[],
  gcEvents: GcEvent[] | undefined,
  heapProfile?: HeapProfile,
  timeProfile?: TimeProfile,
  coverage?: CoverageData,
): void {
  if (gcEvents?.length) {
    const gcStats = aggregateGcStats(gcEvents);
    for (const r of results) r.gcStats = gcStats;
  }
  if (heapProfile) for (const r of results) r.heapProfile = heapProfile;
  if (timeProfile) for (const r of results) r.timeProfile = timeProfile;
  if (coverage) for (const r of results) r.coverage = coverage;
}

/** Resolve WorkerScript path for dev (.ts) or dist (.mjs) */
function resolveWorkerPath(): string {
  const dir = import.meta.dirname!;
  const tsPath = path.join(dir, "WorkerScript.ts");
  if (existsSync(tsPath)) return tsPath;
  return path.join(dir, "runners", "WorkerScript.mjs");
}

import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { isStatefulVariant } from "../matrix/BenchMatrix.ts";
import { loadCaseData, loadCasesModule } from "../matrix/CaseLoader.ts";
import { loadVariant } from "../matrix/VariantLoader.ts";
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

/** Parameters for running a matrix variant */
export interface RunMatrixVariantParams {
  variantDir: string;
  variantId: string;
  caseId: string;
  caseData?: unknown;
  casesModule?: string;
  runner: KnownRunner;
  options: RunnerOptions;
  useWorker?: boolean;
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

/** Run a matrix variant benchmark, either directly or in a worker process */
export async function runMatrixVariant(
  params: RunMatrixVariantParams,
): Promise<MeasuredResults[]> {
  const { variantDir, variantId, caseId, runner, options } = params;
  const { caseData, casesModule, useWorker = true } = params;
  const name = `${variantId}/${caseId}`;

  if (!useWorker) return runMatrixVariantDirect(params, name);

  const spec = { name, fn: () => {} };
  const message: RunMessage = {
    type: "run",
    spec,
    runnerName: runner,
    options,
    variantDir,
    variantId,
    caseId,
    caseData,
    casesModule,
  };
  return runWorkerWithMessage(name, options, message);
}

/** Run matrix variant in-process (no worker isolation) */
async function runMatrixVariantDirect(
  params: RunMatrixVariantParams,
  name: string,
): Promise<MeasuredResults[]> {
  const { variantDir, variantId, caseId, runner, options } = params;
  let { caseData } = params;

  if (params.casesModule && caseId) {
    const casesModule = await loadCasesModule(params.casesModule);
    caseData = (await loadCaseData(casesModule, caseId)).data;
  }

  const variant = await loadVariant(variantDir, variantId);
  let fn: () => void;
  if (isStatefulVariant(variant)) {
    const state = await variant.setup(caseData);
    fn = () => variant.run(state);
  } else {
    fn = () => variant(caseData);
  }

  const benchRunner = await createBenchRunner(runner, options);
  return benchRunner.runBench({ name, fn }, options);
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

/** Serialize a BenchmarkSpec into a worker-safe message (modulePath or fnCode) */
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
        logTiming(
          `Total worker time for ${name}: ${getElapsed(startTime).toFixed(1)}ms`,
        );
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
      reject(
        new Error(`Worker process failed for "${name}": ${error.message}`),
      );
    });
    worker.on("exit", (code: number | null) => {
      if (code !== 0 && code !== null) {
        killWorker();
        reject(
          new Error(`Worker exited with code ${code} for benchmark "${name}"`),
        );
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
  return fork(workerPath, [], { execArgv, silent: gcStats, env });
}

/** Capture and parse GC lines from stdout (V8's --trace-gc-nvp outputs to stdout) */
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

// Consider: --no-compilation-cache, --max-old-space-size=512, --no-lazy
// for consistency (less realistic)

/** Mutate results to include GC stats, heap/time profiles, and coverage */
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

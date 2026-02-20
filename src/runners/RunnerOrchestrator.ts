import { type ChildProcess, fork } from "node:child_process";
import path from "node:path";
import type { BenchmarkSpec } from "../Benchmark.ts";
import type { HeapProfile } from "../heap-sample/HeapSampler.ts";
import type { MeasuredResults } from "../MeasuredResults.ts";
import {
  type AdaptiveOptions,
  createAdaptiveWrapper,
} from "./AdaptiveWrapper.ts";
import type { RunnerOptions } from "./BenchRunner.ts";
import { createRunner, type KnownRunner } from "./CreateRunner.ts";
import { aggregateGcStats, type GcEvent, parseGcLine } from "./GcStats.ts";
import { debugWorkerTiming, getElapsed, getPerfNow } from "./TimingUtils.ts";
import type {
  ErrorMessage,
  ResultMessage,
  RunMessage,
} from "./WorkerScript.ts";

const logTiming = debugWorkerTiming
  ? (message: string) => console.log(`[RunnerOrchestrator] ${message}`)
  : () => {};

type WorkerParams<T = unknown> = {
  spec: BenchmarkSpec<T>;
  runner: KnownRunner;
  options: RunnerOptions;
  params?: T;
};

type WorkerHandlers = {
  resolve: (results: MeasuredResults[], heapProfile?: HeapProfile) => void;
  reject: (error: Error) => void;
};

interface RunBenchmarkParams<T = unknown> {
  spec: BenchmarkSpec<T>;
  runner: KnownRunner;
  options: RunnerOptions;
  useWorker?: boolean;
  params?: T;
}

/** Execute benchmarks directly or in worker process */
export async function runBenchmark<T = unknown>({
  spec,
  runner,
  options,
  useWorker = false,
  params,
}: RunBenchmarkParams<T>): Promise<MeasuredResults[]> {
  if (!useWorker) {
    const resolvedSpec = spec.modulePath
      ? await resolveModuleSpec(spec, params)
      : { spec, params };

    const base = await createRunner(runner);
    const benchRunner = (options as any).adaptive
      ? createAdaptiveWrapper(base, options as AdaptiveOptions)
      : base;
    return benchRunner.runBench(
      resolvedSpec.spec,
      options,
      resolvedSpec.params,
    );
  }

  return runInWorker({ spec, runner, options, params });
}

/** Resolve modulePath/exportName to a real function for non-worker mode */
async function resolveModuleSpec<T>(
  spec: BenchmarkSpec<T>,
  params: T | undefined,
): Promise<{ spec: BenchmarkSpec<T>; params: T | undefined }> {
  const module = await import(spec.modulePath!);

  const fn = spec.exportName
    ? module[spec.exportName]
    : module.default || module;

  if (typeof fn !== "function") {
    const name = spec.exportName || "default";
    throw new Error(
      `Export '${name}' from ${spec.modulePath} is not a function`,
    );
  }

  let resolvedParams = params;
  if (spec.setupExportName) {
    const setupFn = module[spec.setupExportName];
    if (typeof setupFn !== "function") {
      const msg = `Setup export '${spec.setupExportName}' from ${spec.modulePath} is not a function`;
      throw new Error(msg);
    }
    resolvedParams = await setupFn(params);
  }

  return { spec: { ...spec, fn }, params: resolvedParams };
}

/** Run benchmark in isolated worker process */
async function runInWorker<T>(
  workerParams: WorkerParams<T>,
): Promise<MeasuredResults[]> {
  const { spec, runner, options, params } = workerParams;
  const msg = createRunMessage(spec, runner, options, params);
  return runWorkerWithMessage(spec.name, options, msg);
}

/** Create worker process with timing logs */
function createWorkerWithTiming(gcStats: boolean) {
  const workerStart = getPerfNow();
  const gcEvents: GcEvent[] = [];
  const worker = createWorkerProcess(gcStats);
  const createTime = getPerfNow();
  if (gcStats && worker.stdout) setupGcCapture(worker, gcEvents);
  logTiming(
    `Worker process created in ${getElapsed(workerStart, createTime).toFixed(1)}ms`,
  );
  return { worker, createTime, gcEvents };
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
    const { worker, createTime, gcEvents } =
      createWorkerWithTiming(collectGcStats);
    const handlers = createWorkerHandlers(
      name,
      startTime,
      gcEvents,
      resolve,
      reject,
    );
    setupWorkerHandlers(worker, name, handlers);
    sendWorkerMessage(worker, message, createTime);
  });
}

/** Send message to worker with timing log */
function sendWorkerMessage(
  worker: ReturnType<typeof createWorkerProcess>,
  message: RunMessage,
  createTime: number,
): void {
  const messageTime = getPerfNow();
  worker.send(message);
  logTiming(
    `Message sent to worker in ${getElapsed(createTime, messageTime).toFixed(1)}ms`,
  );
}

/** Setup worker event handlers with cleanup */
function setupWorkerHandlers(
  worker: ReturnType<typeof createWorkerProcess>,
  specName: string,
  handlers: WorkerHandlers,
) {
  const { resolve, reject } = handlers;
  const cleanup = createCleanup(worker, specName, reject);
  worker.on(
    "message",
    createMessageHandler(specName, cleanup, resolve, reject),
  );
  worker.on("error", createErrorHandler(specName, cleanup, reject));
  worker.on("exit", createExitHandler(specName, cleanup, reject));
}

/** Handle worker messages (results or errors) */
function createMessageHandler(
  specName: string,
  cleanup: () => void,
  resolve: (results: MeasuredResults[], heapProfile?: HeapProfile) => void,
  reject: (error: Error) => void,
) {
  return (msg: ResultMessage | ErrorMessage) => {
    cleanup();
    if (msg.type === "result") {
      resolve(msg.results, msg.heapProfile);
    } else if (msg.type === "error") {
      const error = new Error(`Benchmark "${specName}" failed: ${msg.error}`);
      if (msg.stack) error.stack = msg.stack;
      reject(error);
    }
  };
}

/** Handle worker process errors */
function createErrorHandler(
  specName: string,
  cleanup: () => void,
  reject: (error: Error) => void,
) {
  return (error: Error) => {
    cleanup();
    reject(
      new Error(
        `Worker process failed for benchmark "${specName}": ${error.message}`,
      ),
    );
  };
}

/** Handle worker process exit */
function createExitHandler(
  specName: string,
  cleanup: () => void,
  reject: (error: Error) => void,
) {
  return (code: number | null, _signal: NodeJS.Signals | null) => {
    if (code !== 0 && code !== null) {
      cleanup();
      const msg = `Worker exited with code ${code} for benchmark "${specName}"`;
      reject(new Error(msg));
    }
  };
}

/** Create cleanup for timeout and termination */
function createCleanup(
  worker: ReturnType<typeof createWorkerProcess>,
  specName: string,
  reject: (error: Error) => void,
) {
  const timeoutId = setTimeout(() => {
    cleanup();
    reject(new Error(`Benchmark "${specName}" timed out after 60 seconds`));
  }, 60000);
  const cleanup = () => {
    clearTimeout(timeoutId);
    if (!worker.killed) worker.kill("SIGTERM");
  };
  return cleanup;
}

/** Create worker process with configuration */
function createWorkerProcess(gcStats: boolean) {
  const workerPath = path.join(import.meta.dirname!, "WorkerScript.ts");
  const execArgv = [
    "--expose-gc",
    "--allow-natives-syntax",
    "--experimental-strip-types",
    "--no-warnings=ExperimentalWarning",
  ];
  if (gcStats) execArgv.push("--trace-gc-nvp");

  return fork(workerPath, [], {
    execArgv,
    silent: gcStats, // Capture stdout/stderr when collecting GC stats
    env: {
      ...process.env,
      NODE_OPTIONS: "",
    },
  });
}

// Consider: --no-compilation-cache, --max-old-space-size=512, --no-lazy
// for consistency (less realistic)

/** @return handlers that attach GC stats and heap profile to results */
function createWorkerHandlers(
  specName: string,
  startTime: number,
  gcEvents: GcEvent[] | undefined,
  resolve: (results: MeasuredResults[]) => void,
  reject: (error: Error) => void,
): WorkerHandlers {
  return {
    resolve: (results: MeasuredResults[], heapProfile?: HeapProfile) => {
      logTiming(
        `Total worker time for ${specName}: ${getElapsed(startTime).toFixed(1)}ms`,
      );
      if (gcEvents?.length) {
        const gcStats = aggregateGcStats(gcEvents);
        for (const r of results) r.gcStats = gcStats;
      }
      if (heapProfile) for (const r of results) r.heapProfile = heapProfile;
      resolve(results);
    },
    reject,
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

/** Run a matrix variant benchmark in isolated worker process */
export async function runMatrixVariant(
  params: RunMatrixVariantParams,
): Promise<MeasuredResults[]> {
  const {
    variantDir,
    variantId,
    caseId,
    caseData,
    casesModule,
    runner,
    options,
  } = params;
  const name = `${variantId}/${caseId}`;
  const message: RunMessage = {
    type: "run",
    spec: { name, fn: () => {} },
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

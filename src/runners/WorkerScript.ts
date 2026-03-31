#!/usr/bin/env node
import { variantModuleUrl } from "../matrix/VariantLoader.ts";
import type { CoverageData } from "../profiling/node/CoverageTypes.ts";
import type { HeapProfile } from "../profiling/node/HeapSampler.ts";
import type { TimeProfile } from "../profiling/node/TimeSampler.ts";
import type { BenchmarkFunction, BenchmarkSpec } from "./BenchmarkSpec.ts";
import type { BenchRunner, RunnerOptions } from "./BenchRunner.ts";
import type { KnownRunner } from "./CreateRunner.ts";
import type { MeasuredResults } from "./MeasuredResults.ts";
import { createBenchRunner, importBenchFn } from "./RunnerUtils.ts";
import { debugWorkerTiming, getElapsed, getPerfNow } from "./TimingUtils.ts";

/** Message sent to worker process to start a benchmark run. */
export interface RunMessage {
  type: "run";
  spec: BenchmarkSpec;
  runnerName: KnownRunner;
  options: RunnerOptions;
  /** Serialized function body (mutually exclusive with modulePath) */
  fnCode?: string;
  /** Module to import for the benchmark function */
  modulePath?: string;
  /** Named export from the module (defaults to default export) */
  exportName?: string;
  /** Setup function export: called once, result passed as params to fn */
  setupExportName?: string;
  params?: unknown;

  /** Directory URL containing variant .ts files (BenchMatrix mode) */
  variantDir?: string;
  /** Variant filename without .ts extension */
  variantId?: string;
  /** Data to pass to variant function */
  caseData?: unknown;
  /** Case identifier */
  caseId?: string;
  /** URL to cases module (exports cases[] and loadCase()) */
  casesModule?: string;
}

/** Message returned from worker process with benchmark results. */
export interface ResultMessage {
  type: "result";
  results: MeasuredResults[];
  heapProfile?: HeapProfile;
  timeProfile?: TimeProfile;
  coverage?: CoverageData;
}

/** Message returned from worker process when benchmark fails. */
export interface ErrorMessage {
  type: "error";
  error: string;
  stack?: string;
}

export type WorkerMessage = RunMessage | ResultMessage | ErrorMessage;

interface BenchmarkImportResult {
  fn: BenchmarkFunction;
  params: unknown;
}

/** Profiling state accumulated during worker benchmark execution */
interface ProfilingState {
  heapProfile?: HeapProfile;
  timeProfile?: TimeProfile;
  coverage?: CoverageData;
  /** Shared session so TimeSampler doesn't reset coverage counters */
  profilerSession?: import("node:inspector/promises").Session;
}

const workerStartTime = getPerfNow();
const maxLifetime = 5 * 60 * 1000;

/** Log timing with consistent format */
const logTiming = debugWorkerTiming ? _logTiming : () => {};
function _logTiming(operation: string, duration?: number) {
  const suffix = duration !== undefined ? ` ${duration.toFixed(1)}ms` : "";
  console.log(`[Worker] ${operation}${suffix}`);
}

/** Send message and exit with duration log */
function sendAndExit(msg: ResultMessage | ErrorMessage, exitCode: number) {
  process.send!(msg, undefined, undefined, (err: Error | null): void => {
    if (err) {
      const kind = msg.type === "result" ? "results" : "error message";
      console.error(`[Worker] Error sending ${kind}:`, err);
    }
    const suffix = exitCode === 0 ? "" : " (error)";
    logTiming(`Total worker duration${suffix}:`, getElapsed(workerStartTime));
    process.exit(exitCode);
  });
}

/** Resolve benchmark function from message (variant dir, module path, or fnCode) */
async function resolveBenchmarkFn(
  message: RunMessage,
): Promise<BenchmarkImportResult> {
  if (message.variantDir && message.variantId) {
    return importVariantModule(message);
  }
  if (message.modulePath) {
    return importBenchmarkWithSetup(message);
  }
  return { fn: reconstructFunction(message.fnCode!), params: message.params };
}

/** Import variant from directory and prepare benchmark function */
async function importVariantModule(
  message: RunMessage,
): Promise<BenchmarkImportResult> {
  const { variantDir, variantId, caseId, casesModule } = message;
  let { caseData } = message;
  const moduleUrl = variantModuleUrl(variantDir!, variantId!);
  logTiming(`Importing variant ${variantId} from ${variantDir}`);

  if (casesModule && caseId) {
    caseData = (await loadCaseFromModule(casesModule, caseId)).data;
  }

  const module = await import(moduleUrl);
  const { setup, run } = module;

  if (typeof run !== "function") {
    throw new Error(`Variant '${variantId}' must export 'run' function`);
  }

  // Stateful variant: setup returns state, run receives state
  if (typeof setup === "function") {
    logTiming(`Calling setup for ${variantId}`);
    const state = await setup(caseData);
    return { fn: () => run(state), params: undefined };
  }

  // Stateless variant: run receives caseData directly
  return { fn: () => run(caseData), params: undefined };
}

/** Import benchmark function and optionally run setup */
async function importBenchmarkWithSetup(
  message: RunMessage,
): Promise<BenchmarkImportResult> {
  const { modulePath, exportName, setupExportName, params } = message;
  const suffix = exportName ? ` (${exportName})` : "";
  logTiming(`Importing from ${modulePath}${suffix}`);
  if (setupExportName) logTiming(`Calling setup: ${setupExportName}`);
  return importBenchFn(modulePath!, exportName, setupExportName, params);
}

/** Reconstruct function from string code */
function reconstructFunction(fnCode: string): BenchmarkFunction {
  // biome-ignore lint/security/noGlobalEval: Necessary for worker process isolation, code is from trusted source
  const fn = eval(`(${fnCode})`); // eslint-disable-line no-eval
  if (typeof fn !== "function") {
    throw new Error("Reconstructed code is not a function");
  }
  return fn;
}

/** Load case data from a cases module */
async function loadCaseFromModule(
  casesModuleUrl: string,
  caseId: string,
): Promise<{ data: unknown; metadata?: Record<string, unknown> }> {
  logTiming(`Loading case '${caseId}' from ${casesModuleUrl}`);
  const module = await import(casesModuleUrl);
  if (typeof module.loadCase === "function") {
    return module.loadCase(caseId);
  }
  return { data: caseId };
}

/** Create error message from exception */
function createErrorMessage(error: unknown): ErrorMessage {
  return {
    type: "error",
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

/** Run benchmark with heap, time, and/or coverage profiling enabled. */
async function runWithProfiling(
  message: RunMessage,
  runner: BenchRunner,
): Promise<ResultMessage> {
  const state: ProfilingState = {};
  const runBench = buildProfilingChain(message, runner, state);

  if (!message.options.callCounts) {
    const results = await runBench();
    return { type: "result", results, ...state };
  }

  const { withCoverageProfiling } = await import(
    "../profiling/node/CoverageSampler.ts"
  );
  const r = await withCoverageProfiling(async session => {
    state.profilerSession = session;
    return runBench();
  });
  state.coverage = r.coverage;
  return { type: "result", results: r.result, ...state };
}

/** Build nested profiling chain: outer heap, inner time */
function buildProfilingChain(
  message: RunMessage,
  runner: BenchRunner,
  state: ProfilingState,
): () => Promise<MeasuredResults[]> {
  const { alloc, timeSample } = message.options;

  const run = async () => {
    const { fn, params } = await resolveBenchmarkFn(message);
    return runner.runBench({ ...message.spec, fn }, message.options, params);
  };

  const { timeInterval, allocInterval, allocDepth } = message.options;

  const runMaybeWithTime = timeSample
    ? async () => {
        const { withTimeProfiling } = await import(
          "../profiling/node/TimeSampler.ts"
        );
        const opts = { interval: timeInterval, session: state.profilerSession };
        const r = await withTimeProfiling(opts, run);
        state.timeProfile = r.profile;
        return r.result;
      }
    : run;

  return alloc
    ? async () => {
        const { withHeapSampling } = await import(
          "../profiling/node/HeapSampler.ts"
        );
        const opts = {
          samplingInterval: allocInterval,
          stackDepth: allocDepth,
        };
        const r = await withHeapSampling(opts, runMaybeWithTime);
        state.heapProfile = r.profile;
        return r.result;
      }
    : runMaybeWithTime;
}

/**
 * Worker process for isolated benchmark execution.
 * Uses eval() safely in isolated child process with trusted code.
 */
process.on("message", async (message: RunMessage) => {
  if (message.type !== "run") return;

  logTiming(`Processing ${message.spec.name} with ${message.runnerName}`);

  try {
    const start = getPerfNow();
    const runner = await createBenchRunner(message.runnerName, message.options);
    logTiming("Runner created in", getElapsed(start));

    const benchStart = getPerfNow();
    const { alloc, timeSample, callCounts } = message.options;

    let result: ResultMessage;
    if (alloc || timeSample || callCounts) {
      result = await runWithProfiling(message, runner);
    } else {
      const { fn, params } = await resolveBenchmarkFn(message);
      const spec = { ...message.spec, fn };
      const results = await runner.runBench(spec, message.options, params);
      result = { type: "result", results };
    }
    logTiming("Benchmark execution took", getElapsed(benchStart));
    sendAndExit(result, 0);
  } catch (error) {
    sendAndExit(createErrorMessage(error), 1);
  }
});

// Exit after 5 minutes to prevent zombie processes
setTimeout(() => {
  console.error("WorkerScript: Maximum lifetime exceeded, exiting");
  process.exit(1);
}, maxLifetime);

// Prevent stdin from keeping the worker process alive
process.stdin.pause();

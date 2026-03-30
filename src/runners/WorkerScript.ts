#!/usr/bin/env node
import { variantModuleUrl } from "../matrix/VariantLoader.ts";
import type { CoverageData } from "../profiling/node/CoverageTypes.ts";
import type { HeapProfile } from "../profiling/node/HeapSampler.ts";
import type { TimeProfile } from "../profiling/node/TimeSampler.ts";
import {
  type AdaptiveOptions,
  createAdaptiveWrapper,
} from "./AdaptiveWrapper.ts";
import type { BenchmarkFunction, BenchmarkSpec } from "./BenchmarkSpec.ts";
import type { BenchRunner, RunnerOptions } from "./BenchRunner.ts";
import { createRunner, type KnownRunner } from "./CreateRunner.ts";
import type { MeasuredResults } from "./MeasuredResults.ts";
import { debugWorkerTiming, getElapsed, getPerfNow } from "./TimingUtils.ts";

/** Message sent to worker process to start a benchmark run. */
export interface RunMessage {
  type: "run";
  spec: BenchmarkSpec;
  runnerName: KnownRunner;
  options: RunnerOptions;
  fnCode?: string; // Made optional - either fnCode or modulePath is required
  modulePath?: string; // Path to module for dynamic import
  exportName?: string; // Export name from module
  setupExportName?: string; // Setup function export name - called once, result passed to fn
  params?: unknown;
  // Variant directory mode (BenchMatrix)
  variantDir?: string; // Directory URL containing variant .ts files
  variantId?: string; // Variant filename (without .ts)
  caseData?: unknown; // Data to pass to variant
  caseId?: string; // Case identifier
  casesModule?: string; // URL to cases module (exports cases[] and loadCase())
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
const logTiming = debugWorkerTiming
  ? (operation: string, duration?: number) => {
      const suffix = duration !== undefined ? ` ${duration.toFixed(1)}ms` : "";
      console.log(`[Worker] ${operation}${suffix}`);
    }
  : () => {};

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
  const module = await import(modulePath!);
  const fn = getModuleExport(module, exportName, modulePath!);

  if (setupExportName) {
    logTiming(`Calling setup: ${setupExportName}`);
    const setupFn = getModuleExport(module, setupExportName, modulePath!);
    return { fn, params: await setupFn(params) };
  }

  return { fn, params };
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

/** Get named or default export from module */
function getModuleExport(
  module: any,
  exportName: string | undefined,
  modulePath: string,
): BenchmarkFunction {
  const fn = exportName ? module[exportName] : module.default || module;
  if (typeof fn !== "function") {
    const name = exportName || "default";
    throw new Error(`Export '${name}' from ${modulePath} is not a function`);
  }
  return fn;
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

  const { callCounts } = message.options;
  let results: MeasuredResults[];
  if (callCounts) {
    const { withCoverageProfiling } = await import(
      "../profiling/node/CoverageSampler.ts"
    );
    const r = await withCoverageProfiling(async session => {
      state.profilerSession = session;
      return runBench();
    });
    state.coverage = r.coverage;
    results = r.result;
  } else {
    results = await runBench();
  }

  return { type: "result", results, ...state };
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
    const baseRunner = await createRunner(message.runnerName);

    const runner = (message.options as any).adaptive
      ? createAdaptiveWrapper(baseRunner, message.options as AdaptiveOptions)
      : baseRunner;

    logTiming("Runner created in", getElapsed(start));

    const benchStart = getPerfNow();
    const { alloc, timeSample, callCounts } = message.options;

    if (alloc || timeSample || callCounts) {
      const result = await runWithProfiling(message, runner);
      logTiming("Benchmark execution took", getElapsed(benchStart));
      sendAndExit(result, 0);
    } else {
      const { fn, params } = await resolveBenchmarkFn(message);
      const spec = { ...message.spec, fn };
      const results = await runner.runBench(spec, message.options, params);
      logTiming("Benchmark execution took", getElapsed(benchStart));
      sendAndExit({ type: "result", results }, 0);
    }
  } catch (error) {
    sendAndExit(createErrorMessage(error), 1);
  }
});

// Exit after 5 minutes to prevent zombie processes
setTimeout(() => {
  console.error("WorkerScript: Maximum lifetime exceeded, exiting");
  process.exit(1);
}, maxLifetime);

process.stdin.pause();

#!/usr/bin/env node
import type { Session } from "node:inspector/promises";
import type { CoverageData } from "../profiling/node/CoverageTypes.ts";
import type { HeapProfile } from "../profiling/node/HeapSampler.ts";
import type { TimeProfile } from "../profiling/node/TimeSampler.ts";
import type { BenchmarkFunction, BenchmarkSpec } from "./BenchmarkSpec.ts";
import type { BenchRunner, RunnerOptions } from "./BenchRunner.ts";
import type { KnownRunner } from "./CreateRunner.ts";
import type { MeasuredResults } from "./MeasuredResults.ts";
import {
  createBenchRunner,
  importBenchFn,
  resolveVariantFn,
} from "./RunnerUtils.ts";
import { debugWorkerTiming, getElapsed, getPerfNow } from "./TimingUtils.ts";

/** Message sent to worker process to start a benchmark run. */
export interface RunMessage {
  type: "run";
  spec: BenchmarkSpec;
  runnerName: KnownRunner;
  options: RunnerOptions;
  /** Serialized function body (mutually exclusive with modulePath) */
  fnCode?: string;
  modulePath?: string;
  /** Defaults to default export */
  exportName?: string;
  /** Called once before benchmarking; result passed as params to fn */
  setupExportName?: string;
  params?: unknown;

  /** Directory URL containing variant .ts files (BenchMatrix mode) */
  variantDir?: string;
  /** Variant filename without .ts extension */
  variantId?: string;
  caseData?: unknown;
  caseId?: string;
  /** Module URL exporting cases[] and loadCase() */
  casesModule?: string;
}

/** Benchmark results returned from worker process. */
export interface ResultMessage {
  type: "result";
  results: MeasuredResults[];
  heapProfile?: HeapProfile;
  timeProfile?: TimeProfile;
  coverage?: CoverageData;
}

/** Error returned from worker process when benchmark fails. */
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
  profilerSession?: Session;
}

const workerStartTime = getPerfNow();
const maxLifetime = 5 * 60 * 1000;

const logTiming = debugWorkerTiming ? _logTiming : () => {};
function _logTiming(operation: string, duration?: number) {
  const suffix = duration !== undefined ? ` ${duration.toFixed(1)}ms` : "";
  console.log(`[Worker] ${operation}${suffix}`);
}

/** Send IPC message to parent then exit the worker process */
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
    const { modulePath, exportName, setupExportName, params } = message;
    logTiming(
      `Importing from ${modulePath}${exportName ? ` (${exportName})` : ""}`,
    );
    if (setupExportName) logTiming(`Calling setup: ${setupExportName}`);
    return importBenchFn(modulePath, exportName, setupExportName, params);
  }
  return { fn: reconstructFunction(message.fnCode!), params: message.params };
}

/** Import variant from directory and prepare benchmark function */
async function importVariantModule(
  message: RunMessage,
): Promise<BenchmarkImportResult> {
  const { variantDir, variantId } = message;
  logTiming(`Importing variant ${variantId} from ${variantDir}`);
  return resolveVariantFn({
    ...message,
    variantDir: variantDir!,
    variantId: variantId!,
  });
}

/** Eval serialized function body back into a callable */
function reconstructFunction(fnCode: string): BenchmarkFunction {
  // biome-ignore lint/security/noGlobalEval: Necessary for worker process isolation, code is from trusted source
  const fn = eval(`(${fnCode})`); // eslint-disable-line no-eval
  if (typeof fn !== "function") {
    throw new Error("Reconstructed code is not a function");
  }
  return fn;
}

/** Run benchmark with optional heap, time, and coverage profiling */
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

/** Build nested profiling wrappers: outer heap, inner time */
function buildProfilingChain(
  message: RunMessage,
  runner: BenchRunner,
  state: ProfilingState,
): () => Promise<MeasuredResults[]> {
  const { alloc, profile, profileInterval, allocInterval, allocDepth } =
    message.options;

  const run = async () => {
    const { fn, params } = await resolveBenchmarkFn(message);
    return runner.runBench({ ...message.spec, fn }, message.options, params);
  };

  const runMaybeWithTime = profile
    ? async () => {
        const { withTimeProfiling } = await import(
          "../profiling/node/TimeSampler.ts"
        );
        const opts = {
          interval: profileInterval,
          session: state.profilerSession,
        };
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
        const heapOpts = {
          samplingInterval: allocInterval,
          stackDepth: allocDepth,
        };
        const r = await withHeapSampling(heapOpts, runMaybeWithTime);
        state.heapProfile = r.profile;
        return r.result;
      }
    : runMaybeWithTime;
}

process.on("message", async (message: RunMessage) => {
  if (message.type !== "run") return;

  logTiming(`Processing ${message.spec.name} with ${message.runnerName}`);

  try {
    const start = getPerfNow();
    const runner = await createBenchRunner(message.runnerName, message.options);
    logTiming("Runner created in", getElapsed(start));

    const benchStart = getPerfNow();
    const result = await runWithProfiling(message, runner);
    logTiming("Benchmark execution took", getElapsed(benchStart));
    sendAndExit(result, 0);
  } catch (error) {
    const err = error instanceof Error ? error : undefined;
    sendAndExit(
      {
        type: "error",
        error: err?.message ?? String(error),
        stack: err?.stack,
      },
      1,
    );
  }
});

// Prevent zombie processes
setTimeout(() => {
  console.error("WorkerScript: Maximum lifetime exceeded, exiting");
  process.exit(1);
}, maxLifetime);

// Prevent stdin from keeping the worker process alive
process.stdin.pause();

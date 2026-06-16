#!/usr/bin/env node
import type { Session } from "node:inspector/promises";
import type { CoverageData } from "../profiling/node/CoverageTypes.ts";
import type { HeapProfile } from "../profiling/node/HeapSampler.ts";
import type { TimeProfile } from "../profiling/node/TimeSampler.ts";
import type { BenchmarkFunction, BenchmarkSpec } from "./BenchmarkSpec.ts";
import { BenchRunner, type RunnerOptions } from "./BenchRunner.ts";
import type { MeasuredResults } from "./MeasuredResults.ts";
import {
  evalFn,
  importBenchFn,
  resolveVariantFn,
  type VariantSource,
} from "./RunnerUtils.ts";

/** Message sent to worker process to start a benchmark run. */
export interface RunMessage {
  type: "run";
  spec: BenchmarkSpec;
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
  /** Inline variant run fn source (BenchMatrix inline mode) */
  variantRunCode?: string;
  /** Inline variant setup fn source (stateful inline variant) */
  variantSetupCode?: string;
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

const maxLifetime = 5 * 60 * 1000;

/** Send IPC message to parent then exit the worker process */
function sendAndExit(msg: ResultMessage | ErrorMessage, exitCode: number) {
  process.send!(msg, undefined, undefined, (err: Error | null): void => {
    if (err) {
      const kind = msg.type === "result" ? "results" : "error message";
      console.error(`[Worker] Error sending ${kind}:`, err);
    }
    process.exit(exitCode);
  });
}

/** Resolve benchmark function from message (matrix variant, module path, or fnCode) */
async function resolveBenchmarkFn(
  message: RunMessage,
): Promise<BenchmarkImportResult> {
  const source = variantSource(message);
  if (source) {
    const { caseId, caseData, casesModule } = message;
    return resolveVariantFn({ source, caseId, caseData, casesModule });
  }
  if (message.modulePath) {
    const { modulePath, exportName, setupExportName, params } = message;
    return importBenchFn(modulePath, exportName, setupExportName, params);
  }
  return {
    fn: evalFn(message.fnCode!) as BenchmarkFunction,
    params: message.params,
  };
}

/** The matrix variant source carried by a run message, if any (dir or inline). */
function variantSource(message: RunMessage): VariantSource | undefined {
  const { variantDir, variantId, variantRunCode, variantSetupCode } = message;
  if (variantDir && variantId) return { variantDir, variantId };
  if (variantRunCode)
    return {
      runCode: variantRunCode,
      setupCode: variantSetupCode,
      variantId: variantId ?? "",
    };
  return undefined;
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
  const { alloc, profile } = message.options;

  const run = async () => {
    const { fn, params } = await resolveBenchmarkFn(message);
    return runner.runBench({ ...message.spec, fn }, message.options, params);
  };

  const runMaybeWithTime = profile ? wrapWithTime(run, message, state) : run;
  if (!alloc) return runMaybeWithTime;
  return wrapWithHeap(runMaybeWithTime, message, state);
}

/** Wrap a run with CPU time profiling, recording the profile into state. */
function wrapWithTime(
  run: () => Promise<MeasuredResults[]>,
  message: RunMessage,
  state: ProfilingState,
): () => Promise<MeasuredResults[]> {
  return async () => {
    const { withTimeProfiling } = await import(
      "../profiling/node/TimeSampler.ts"
    );
    const interval = message.options.profileInterval;
    const opts = { interval, session: state.profilerSession };
    const r = await withTimeProfiling(opts, run);
    state.timeProfile = r.profile;
    return r.result;
  };
}

/** Wrap a run with heap allocation sampling, recording the profile into state. */
function wrapWithHeap(
  run: () => Promise<MeasuredResults[]>,
  message: RunMessage,
  state: ProfilingState,
): () => Promise<MeasuredResults[]> {
  return async () => {
    const { withHeapSampling } = await import(
      "../profiling/node/HeapSampler.ts"
    );
    const { allocInterval, allocDepth } = message.options;
    const heapOpts = {
      samplingInterval: allocInterval,
      stackDepth: allocDepth,
    };
    const r = await withHeapSampling(heapOpts, run);
    state.heapProfile = r.profile;
    return r.result;
  };
}

process.on("message", async (message: RunMessage) => {
  if (message.type !== "run") return;

  try {
    const runner = new BenchRunner();
    const result = await runWithProfiling(message, runner);
    sendAndExit(result, 0);
  } catch (error) {
    const err = error instanceof Error ? error : undefined;
    const errorMsg: ErrorMessage = {
      type: "error",
      error: err?.message ?? String(error),
      stack: err?.stack,
    };
    sendAndExit(errorMsg, 1);
  }
});

// Prevent zombie processes
setTimeout(() => {
  console.error("WorkerScript: Maximum lifetime exceeded, exiting");
  process.exit(1);
}, maxLifetime);

// Prevent stdin from keeping the worker process alive
process.stdin.pause();

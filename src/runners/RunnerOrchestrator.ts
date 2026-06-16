import type { BenchmarkFunction, BenchmarkSpec } from "./BenchmarkSpec.ts";
import { BenchRunner, type RunnerOptions } from "./BenchRunner.ts";
import type { MeasuredResults } from "./MeasuredResults.ts";
import {
  importBenchFn,
  resolveVariantFn,
  type VariantSource,
} from "./RunnerUtils.ts";
import { runWorkerWithMessage } from "./WorkerRunner.ts";
import type { RunMessage } from "./WorkerScript.ts";

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
    return new BenchRunner().runBench(resolved.spec, options, resolved.params);
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
  return new BenchRunner().runBench({ name, fn }, options);
}

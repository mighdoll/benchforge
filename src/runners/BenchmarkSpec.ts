/** Benchmark function with optional module path for worker-mode serialization. */
export interface BenchmarkSpec<T = unknown> {
  name: string;
  fn: BenchmarkFunction<T>;
  /** Path to module exporting the benchmark function (for worker mode) */
  modulePath?: string;
  /** Name of the exported function in the module (defaults to default export) */
  exportName?: string;
  /** Setup function export name - called once in worker, result passed to fn */
  setupExportName?: string;
}

/** Benchmark function, optionally receiving setup parameters from the group. */
export type BenchmarkFunction<T = unknown> =
  | ((params: T) => void)
  | (() => void);

/** Group of benchmarks with shared setup and optional baseline. */
export interface BenchGroup<T = unknown> {
  name: string;
  setup?: () => T | Promise<T>;
  benchmarks: BenchmarkSpec<T>[];
  baseline?: BenchmarkSpec<T>;
  /** Metadata for reporting (e.g. lines of code). */
  metadata?: Record<string, any>;
}

/** Named collection of benchmark groups. */
export interface BenchSuite {
  name: string;
  groups: BenchGroup<any>[];
}

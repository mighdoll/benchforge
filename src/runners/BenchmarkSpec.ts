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

/** Benchmark function, optionally receiving setup parameters. */
export type BenchmarkFunction<T = unknown> =
  | ((params: T) => void)
  | (() => void);

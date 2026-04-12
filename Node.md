# Node.js Benchmarking

Node benchmarks run in isolated child processes (workers) by default. Pass a
TypeScript file exporting a default function or `BenchSuite`, and benchforge
handles the rest.

```bash
benchforge my-bench.ts --gc-stats
```

## BenchSuite

For multiple benchmarks with groups, setup data, and baseline comparison, export
a `BenchSuite`:

```typescript
// sorting.ts
import type { BenchGroup, BenchSuite } from 'benchforge';

const sortingGroup: BenchGroup<number[]> = {
  name: "Array Sorting (1000 numbers)",
  setup: () => Array.from({ length: 1000 }, () => Math.random()),
  baseline: { name: "native sort", fn: (arr) => [...arr].sort((a, b) => a - b) },
  benchmarks: [
    { name: "quicksort", fn: quickSort },
    { name: "insertion sort", fn: insertionSort },
  ],
};

const suite: BenchSuite = {
  name: "Performance Tests",
  groups: [sortingGroup],
};

export default suite;
```

```bash
benchforge sorting.ts --gc-stats
```

## Custom Metrics

The built-in report columns (mean, p50, p99, runs, gc, ...) cover typical timing
needs. For throughput metrics or domain-specific counts — "lines per second",
"tokens parsed", "cost per request" — define a `ReportSection` and hand it to
`benchExports`.

A `ReportSection` is a plain object with a `title` and an array of `columns`.
Each column either has a `statKind` (the framework computes it from raw samples)
or a `value` accessor (for non-sample data like metadata fields). Here is a
minimal `lines/sec` section:

```typescript
import {
  type BenchSuite,
  benchExports,
  integer,
  type MeasuredResults,
  parseBenchArgs,
  type ReportSection,
  runsSection,
  timeSection,
} from "benchforge";

function msToLocSec(ms: number, meta?: Record<string, unknown>): number {
  const lines = (meta?.linesOfCode ?? 0) as number;
  return lines / (ms / 1000);
}

const locSection: ReportSection = {
  title: "throughput",
  columns: [
    {
      key: "locPerSec",
      title: "lines/sec",
      formatter: integer,
      comparable: true,
      higherIsBetter: true,
      statKind: "mean",
      toDisplay: msToLocSec,
    },
    {
      key: "lines",
      title: "lines",
      formatter: integer,
      value: (_r: MeasuredResults, meta?: Record<string, unknown>) =>
        meta?.linesOfCode ?? 0,
    },
  ],
};

const suite: BenchSuite = {
  name: "Parser",
  groups: [{
    name: "parse",
    metadata: { linesOfCode: 500 },
    benchmarks: [{ name: "my-parser", fn: () => parseSource(source) }],
  }],
};

await benchExports(suite, parseBenchArgs(), {
  sections: [locSection, timeSection, runsSection],
});
```

When `sections` is passed, it **replaces** the CLI-derived defaults — include
`timeSection`, `runsSection`, or `gcSections(args)` explicitly if you still want
them. Built-in sections you can compose with your own: `timeSection`,
`runsSection`, `totalTimeSection`, `adaptiveSections`, `optSection`, `gcSection`,
`gcStatsSection`, and `gcSections(args)` (the last returns a CLI-flag-driven
list).

**Column options that matter for comparisons:**

- `comparable` — adds a `Δ%` column after this one when a baseline is present.
- `higherIsBetter` — for throughput metrics; flips the sign so a 2× faster
  variant shows `+100%` instead of `-50%`.
- `statKind` — which statistic to compute from raw timing samples (`"mean"`,
  `"min"`, `"max"`, or `{ percentile: 0.5 }`). The bootstrap CI runs on these.
- `toDisplay` — converts a timing-domain value to the **display domain** (ms →
  lines/sec, etc.). Used only for rendering point estimates and CI bounds, not
  for the bootstrap itself. This split is what lets benchforge compute a
  statistically valid CI on ms samples while showing the user lines/sec.
- `value` — accessor for non-sample data (metadata fields, run count, etc.).
  Columns with `value` don't participate in bootstrap.

Matrix suites accept the same `sections` option via `matrixBenchExports` or
`reportMatrixResults({ sections })`.

## Profiling with External Debuggers

Use `--inspect` to run benchmarks once for attaching external profilers:

```bash
# Use with Chrome DevTools profiler
node --inspect-brk $(which benchforge) my-bench.ts --inspect

# Use with other profiling tools
node --prof $(which benchforge) my-bench.ts --inspect
```

The `--inspect` flag executes exactly one iteration with no warmup, making it
ideal for debugging and performance profiling.


## Worker Mode

Workers provide process-level isolation: each benchmark runs in a fresh child
process with its own heap. This is the default (`--no-worker` to disable).

Since functions can't be serialized across process boundaries, worker mode uses
`modulePath` + `exportName` to re-import benchmark functions in the worker:

```typescript
const group: BenchGroup = {
  name: "Parser Benchmark",
  setup: () => loadTestData(),
  benchmarks: [{
    name: "parse",
    fn: () => {},  // placeholder - not used in worker mode
    modulePath: new URL("./benchmarks.ts", import.meta.url).href,
    exportName: "parse",
    setupExportName: "setup",  // optional: called once, result passed to fn
  }],
};
```

When `setupExportName` is provided, the worker:
1. Imports the module
2. Calls `setup(params)` once (where params comes from `BenchGroup.setup()`)
3. Passes the setup result to each benchmark iteration

This eliminates manual caching boilerplate in worker modules.

## Requirements

- Node.js 22.6+ (for native TypeScript support)
- Use `--expose-gc --allow-natives-syntax` flags for garbage collection
  monitoring and V8 native functions

# Node.js Benchmarking

Node benchmarks run in isolated child processes (workers) by default. Pass a
TypeScript file exporting a default function or `MatrixSuite`, and benchforge
handles the rest.

```bash
benchforge my-bench.ts --gc-stats
```

## MatrixSuite

A benchmark is a matrix of **cases** (input data) x **variants** (the functions
under test). For shared input and several functions compared against a baseline,
export a `MatrixSuite`:

```typescript
// sorting.ts
import type { BenchMatrix, MatrixSuite } from 'benchforge';

const sorting: BenchMatrix<number[]> = {
  name: "Array Sorting (1000 numbers)",
  // one case named "numbers"; the thunk runs once to make the shared input
  caseData: { numbers: () => Array.from({ length: 1000 }, () => Math.random()) },
  variants: {
    quicksort: quickSort,
    "insertion sort": insertionSort,
    "native sort": (arr) => [...arr].sort((a, b) => a - b),
  },
  baselineVariant: "native sort",
};

const suite: MatrixSuite = {
  name: "Performance Tests",
  matrices: [sorting],
};

export default suite;
```

```bash
benchforge sorting.ts --gc-stats
```

Each variant is called once per iteration with the case data as its argument.
`baselineVariant` names one variant as the reference; every other variant is
interleaved against it per batch and reported with a `Δ%` verdict. Use multiple
keys in `caseData` (or a `casesModule`) to run the variants across several
inputs; the report groups one card per case.

Inline variant functions are serialized and reconstructed in the worker, so they
must be self-contained (no captured closure variables). For variants that need
imports or shared state, point `variantDir` at a directory of `.ts` files each
exporting `run` (and optionally `setup`), or use `--no-worker`.

## Custom Metrics

The built-in report columns (mean, p50, p99, runs, gc, ...) cover typical timing
needs. For throughput metrics or domain-specific counts ("lines per second",
"tokens parsed", "cost per request"), define a `ReportSection` and hand it to
`benchExports`.

A `ReportSection` is a plain object with a `title` and an array of `columns`.
Each column either has a `statKind` (the framework computes it from raw samples)
or a `value` accessor (for non-sample data like metadata fields). Here is a
minimal `lines/sec` section:

```typescript
import {
  type MatrixSuite,
  integer,
  type MeasuredResults,
  type ReportSection,
  runBenchCli,
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

const suite: MatrixSuite = {
  name: "Parser",
  matrices: [{
    name: "parse",
    variants: { "my-parser": () => parseSource(source) },
  }],
};

await runBenchCli({
  build: () => ({
    suite,
    sections: [locSection, timeSection, runsSection],
  }),
});
```

(Per-benchmark `metadata` like `linesOfCode` comes from the case data or a
`casesModule`'s `loadCase` returning `{ data, metadata }`.)

When `sections` is passed, it **replaces** the CLI-derived defaults; include
`timeSection`, `runsSection`, or `gcSections(args)` explicitly if you still want
them. Built-in sections you can compose with your own: `timeSection`,
`runsSection`, `totalTimeSection`, `adaptiveSections`, `optSection`, `gcSection`,
`gcStatsSection`, and `gcSections(args)` (the last returns a CLI-flag-driven
list).

**Column options that matter for comparisons:**

- `comparable`: adds a `Δ%` column after this one when a baseline is present.
- `higherIsBetter`: for throughput metrics; flips the sign so a 2x faster
  variant shows `+100%` instead of `-50%`.
- `statKind`: which statistic to compute from raw timing samples (`"mean"`,
  `"min"`, `"max"`, or `{ percentile: 0.5 }`). The bootstrap CI runs on these.
- `toDisplay`: converts a timing-domain value to the **display domain** (ms ==>
  lines/sec, etc.). Used only for rendering point estimates and CI bounds, not
  for the bootstrap itself. This split is what lets benchforge compute a
  statistically valid CI on ms samples while showing the user lines/sec.
- `value`: accessor for non-sample data (metadata fields, run count, etc.).
  Columns with `value` don't participate in bootstrap.

Pass `sections` from your `runBenchCli({ build })` result to apply them to any
matrix suite.

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

Inline variant functions are serialized (via `fn.toString()`) and reconstructed
in the worker, so they must be self-contained: a closure that captures a local
variable won't have it in the worker. Two ways to use code that needs imports or
shared state across iterations:

- **Variant directory** (`variantDir`): a directory of `.ts` files, each
  exporting `run` (called per iteration) and optionally `setup` (called once
  with the case data; its result is passed to `run`). Each file is re-imported
  fresh in its worker, so it can `import` whatever it needs.

```typescript
// variants/parse.ts
import { parseSource } from "../parser.ts";
export function setup(caseData) { return loadTestData(caseData); }
export function run(state) { parseSource(state); }
```

```typescript
const matrix: BenchMatrix = {
  name: "Parser Benchmark",
  variantDir: new URL("./variants/", import.meta.url).href,
  casesModule: new URL("./cases.ts", import.meta.url).href,
};
```

- **`--no-worker`**: run in-process, where inline closures work but there is no
  heap isolation between variants.

## Requirements

- Node.js 22.6+ (for native TypeScript support)
- Use `--expose-gc --allow-natives-syntax` flags for garbage collection
  monitoring and V8 native functions

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

The built-in sections (`timeSection`, `runsSection`, `gcSections(args)`) cover
typical timing needs. For throughput metrics or domain-specific counts ("lines
per second", "tokens parsed", "cost per request"), define your own sections and
pass them from `runBenchCli({ build })`.

A `ReportSection` is one of two shapes:

- **`metricSection`** -- one comparable metric that drives the verdict, the
  console headline Δ%, and the HTML shift-function fan. It has a `formatter`, an
  optional `statKind` (the statistic computed from raw samples, default
  `"mean"`), `higherIsBetter`, `toDisplay`, and `extras` (scalar cells shown
  alongside the metric).
- **`scalarSection`** -- a bag of named `rows` pulled from results/metadata (gc,
  run counts, etc.), no bootstrap.

Here is a `lines/sec` throughput metric, with the line count riding along as an
extra scalar cell:

```typescript
import {
  integer,
  type MetricSection,
  metricSection,
  runBenchCli,
  runsSection,
  timeSection,
} from "benchforge";

/** Convert timing ms to lines/sec using the case's lineCount metadata. */
function msToLocSec(ms: number, meta?: Record<string, unknown>): number {
  const lines = (meta?.linesOfCode ?? 0) as number;
  return lines / (ms / 1000);
}

const locSection: MetricSection = metricSection({
  title: "lines / sec",
  higherIsBetter: true,
  toDisplay: msToLocSec,
  formatter: integer,
  extras: [
    {
      key: "lines",
      title: "lines",
      formatter: integer,
      value: (_r, meta) => meta?.linesOfCode ?? 0,
    },
  ],
});

await runBenchCli({
  build: () => ({
    suite: {
      name: "Parser",
      matrices: [{
        name: "parse",
        casesModule: new URL("./cases.ts", import.meta.url).href,
        variantDir: new URL("./variants/", import.meta.url).href,
      }],
    },
    sections: [locSection, timeSection, runsSection],
  }),
});
```

Per-benchmark `metadata` (like `linesOfCode`) comes from the case: a
`casesModule`'s `loadCase(id)` returns `{ data, metadata }`, and that metadata is
passed to `toDisplay` / a scalar row's `value`.

When `sections` is passed, it **replaces** the CLI-derived defaults; include
`timeSection`, `runsSection`, or `gcSections(args)` explicitly if you still want
them.

**`MetricSection` fields that matter for comparisons:**

- `statKind`: which statistic to compute from raw timing samples (`"mean"`,
  `"min"`, `"max"`, `"p50"`, ...), default `"mean"`. The bootstrap CI runs on it.
- `higherIsBetter`: for throughput metrics; flips the sign so a 2x faster
  variant shows `+100%` instead of `-50%`.
- `toDisplay`: converts a timing-domain value to the **display domain** (ms ==>
  lines/sec, etc.). Used only for rendering point estimates and CI bounds, not
  for the bootstrap itself. This split is what lets benchforge compute a
  statistically valid CI on ms samples while showing the user lines/sec.
- `extras`: scalar cells (each a `{ key, title, formatter, value }` row, with
  `value` reading results/metadata) shown next to the metric; they don't
  participate in the bootstrap.

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

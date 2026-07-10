# Configuration

How you define a benchmark suite and its run settings. These are the same in
Node and browser runs: a suite describes the cases and variants to compare, an
optional preset bundles the run flags, and custom sections tailor the report.

For where the code runs, see [Node.md](Node.md) (workers, external debuggers) and
[Browser.md](Browser.md) (`--url`, page-load mode).

## The matrix model

A benchmark is a matrix of **cases** (input data) x **variants** (the functions
under test). For shared input and several functions compared against a baseline,
export a `MatrixSuite`:

```typescript
// copy.ts
import type { BenchMatrix, MatrixSuite } from 'benchforge';

const copying: BenchMatrix<number[]> = {
  name: "Array Copy (50,000 numbers)",
  // one case named "numbers"; the thunk runs once to make the shared input
  caseData: { numbers: () => Array.from({ length: 50_000 }, () => Math.random()) },
  variants: {
    slice: arr => arr.slice(),
    spread: arr => [...arr],
    from: arr => Array.from(arr),
  },
  baselineVariant: "spread",
};

const suite: MatrixSuite = {
  name: "Performance Tests",
  matrices: [copying],
};

export default suite;
```

```bash
benchforge copy.ts --gc-stats
```

Each variant is called once per iteration with the case data as its argument.
`baselineVariant` names one variant as the reference; every other variant is
interleaved against it per batch and reported with a `Δ%` verdict. Use multiple
keys in `caseData` (or a `casesModule`) to run the variants across several
inputs; the report groups one card per case.

The same suite runs in the browser: `benchforge copy.ts --url http://localhost:5173`
launches Chrome and runs each variant in a fresh tab against that harness page,
using the same batching, verdict, and report as a Node run.

## Where each source works

A matrix can source its variants and cases inline (serialized into the run) or
from separate modules. Node supports all of them; the browser supports only the
inline sources, since module sources would need a browser bundle step.

| Source | Node | Browser |
|--------|------|---------|
| `variants` (inline functions) | yes | yes |
| `caseData` (inline thunks) | yes | yes |
| `baselineVariant` | yes | yes |
| `variantDir` (directory of `.ts` files) | yes | no (needs bundling) |
| `casesModule` (external case loader) | yes | no (not yet loaded) |

## Variants that need imports or shared state

Inline variant functions are serialized (via `fn.toString()`) and reconstructed
where they run, so they must be self-contained: a closure that captures a local
variable won't have it at run time. For variants that need imports or shared
state across iterations, point `variantDir` at a directory of `.ts` files, each
exporting `run` (called per iteration) and optionally `setup` (called once with
the case data; its result is passed to `run`). Each file is re-imported fresh, so
it can `import` whatever it needs.

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

`variantDir` and `casesModule` are Node-only (see the table above). In the
browser, keep variants and case data inline, or use `--no-worker` in Node to run
in-process where inline closures work but there is no heap isolation between
variants.

## Presets

A suite can ship named bundles of run settings so you need not retype them. A
suite might define a `quick` preset for everyday checks and a `thorough` one for
slower, more reliable comparisons; select a bundle with `--preset thorough`. A
preset carries its `--equiv-margin` alongside the `--batches` and `--duration` it
was calibrated at, which keeps the margin valid, since a margin measured at one
batch count is wrong for another (see [Calibration.md](Calibration.md)). Explicit
flags still win, so `--preset quick --batches 200` runs the quick preset with 200
batches.

Presets are passed to `runBenchCli`; `defaultPreset` selects one when `--preset`
is omitted:

```typescript
await runBenchCli({
  build: () => ({ suite }),
  presets: {
    quick: { batches: 20, duration: 0.5, "equiv-margin": 1 },
    thorough: { batches: 80, duration: 2, "equiv-margin": 0.5 },
  },
  defaultPreset: "quick",
});
```

## Custom metrics

The built-in sections (`timeSection`, `runsSection`, `gcSections(args)`) cover
typical timing needs. For throughput metrics or domain-specific counts ("lines
per second", "tokens parsed", "cost per request"), define your own sections and
pass them from `runBenchCli({ build })`. Sections drive both Node and browser
reports.

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

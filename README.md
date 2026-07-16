# Benchforge

Benchforge measures JavaScript performance in Node.js and Chrome. It is built
around the two questions every optimization loop asks: **did that change
help?** and **where did the time and memory go?**

Micro-benchmark harnesses print an ops/sec figure that wobbles from run to
run, leaving you to judge whether a change is real. Benchforge is built for
that judgment: it measures its own noise floor, compares whole distributions,
and reports a verdict you can act on.

- **Equivalence testing** -- each comparison ends in a verdict: faster,
  slower, equivalent, or inconclusive, separating "no real difference" from
  "too noisy to tell".
- **Measured noise floor** -- `--calibrate` runs identical code against itself
  to find what your setup can resolve.
- **GC-aware** -- garbage collection triggered by your code is real cost, so
  it stays in the measurement rather than being trimmed as an outlier; the
  report shows it directly, with GC events overlaid on the iteration timeline
  plus allocation rates, collection counts, and pause times.
- **Integrated investigation** -- rerun the same benchmark with `--alloc`,
  `--profile`, or `--call-counts` to measure heap allocation per function,
  CPU time, and call counts, annotated onto your source code.
- **Visualized distributions** -- bootstrap confidence intervals for the mean,
  median, and tail percentiles; a regression that hides in the average still
  shows up at p99.
- **Reports to keep** -- an interactive viewer, a markdown report written on
  every run (easy for coding agents and CI to read), and a single-file
  archive to share with your team.

## The Verdict

Each comparison gets a verdict, with the change shown at every percentile:

<!-- TODO(image): regenerate -- summary card with the verdict badge, headline
change, and the change by percentile chart (violins + margin band). -->
<img width="326" height="363" alt="verdict with change by percentile" src="https://github.com/user-attachments/assets/532702bd-faa1-4cb3-8b33-ad5409631427" />

## Time Per Iteration

Every iteration timed in order, with heap growth and GC overlays:

<!-- TODO(image): regenerate -- time series with the GC sawtooth and full-GC
markers visible. -->
<img width="387" height="306" alt="time series" src="https://github.com/user-attachments/assets/f5676b64-7906-422b-aef3-4eedc325c422" />

## Heap Allocation

Which functions allocate the most, including objects already collected:

<img width="4444" height="2706" alt="allocation view" src="https://github.com/user-attachments/assets/6d4e2dee-bb72-41ce-a71d-d036bebedb3d" />

## Annotated Source

Allocation and call count metrics in the margins of your own code:

<img width="1946" height="460" alt="src annotations" src="https://github.com/user-attachments/assets/102cc574-ecf3-4f5f-8143-d20ee7008a72" />

## Installation

```bash
npm install benchforge
# or
pnpm add benchforge
```

## Quick Start: Node

The simplest benchmark: export a default function and pass the file to
`benchforge`.

```typescript
// my-bench.ts
export default function (): string {
  return "a" + "b";
}
```

```bash
benchforge my-bench.ts --gc-stats
```

To compare variants, export a `MatrixSuite`: cases (input data) x variants
(the functions under test), with one variant named as the baseline.

```typescript
// copy.ts
import type { BenchMatrix, MatrixSuite } from "benchforge";

const copying: BenchMatrix<number[]> = {
  name: "Array Copy (50,000 numbers)",
  caseData: { numbers: () => Array.from({ length: 50_000 }, () => Math.random()) },
  variants: {
    slice: arr => arr.slice(),
    spread: arr => [...arr],
  },
  baselineVariant: "slice",
};

const suite: MatrixSuite = { name: "Performance Tests", matrices: [copying] };
export default suite;
```

```bash
benchforge copy.ts --batches 40
```

Each variant is interleaved against the baseline and reported with a Δ% and a
verdict. See [Configuration.md](Configuration.md) for multiple cases, directory
variants, and custom metrics such as throughput.

## Quick Start: Browser

`benchforge --url <page>` opens Chromium and runs your program.

You can time any page without modification, and compare against a baseline:

```bash
benchforge --url http://localhost:5173 --baseline-url http://localhost:5174 \
  --gc-stats --batches 20 --iterations 10 --headless
```

If you export your test function as `window.__bench`, benchforge runs multiple
iterations in the same tab, which is faster and reveals the accumulated effect
of heap allocation over time.

```html
<!-- bench function mode -->
<script>
window.__bench = () => {
  const arr = Array.from({ length: 10000 }, () => Math.random());
  arr.sort((a, b) => a - b);
};
</script>
```

See [Browser.md](Browser.md) for setup patterns, completion signals, and the
CDP flow.

## Getting an Answer You Can Trust

Comparing identical code never reports exactly zero; the leftover spread is
your setup's noise floor. Measure it once, then use it as the equivalence
margin for real comparisons with the same run settings:

```bash
# 1. measure the noise floor of this machine + benchmark
benchforge copy.ts --calibrate --batches 40 --duration 2
#   ... suggested --equiv-margin 0.5%

# 2. compare against the noise floor
benchforge copy.ts --batches 40 --duration 2 --equiv-margin 0.5
```

A verdict of faster or slower now means the whole confidence interval clears
the noise floor; equivalent means the change is bounded below it; inconclusive
means run more batches. See [Calibration.md](Calibration.md) for sizing runs
and [Statistics.md](Statistics.md) for the methods behind the interval.

## CLI Overview

Core flags for common workflows. Run `benchforge --help` for the full list.

| Flag | What it does |
|------|-------------|
| `--batches <n>` | Interleaved baseline/current rounds (use 40+ to compare) |
| `--duration <sec>` | Time budget per batch (default: 0.642s) |
| `--iterations <n>` | Exact iterations per batch (overrides --duration) |
| `--calibrate` | Measure the noise floor and print a recommended `--equiv-margin` |
| `--equiv-margin <pct>` | Equivalence margin (default: 2%) |
| `--gc-stats` | Collect GC allocation and collection stats |
| `--alloc` | Measure heap allocation per function |
| `--profile` | Profile CPU time (V8 sampling profiler) |
| `--call-counts` | Count executions per function |
| `--filter <pattern>` | Run only benchmarks matching regex/substring |
| `--view` | Open interactive viewer (on by default in an interactive terminal; `--no-view` disables) |
| `--archive [file]` | Archive profiles + sources to a `.benchforge` file |
| `--url <url>` | Benchmark a browser page |
| `--baseline-url <url>` | A/B comparison in browser |

`benchforge view <file.benchforge>` reopens an archive in the viewer.

Notes typed in the box at the top of the viewer's Summary page are saved with the
archive; opening a file with `benchforge view <file>` writes edits back to that
file.

## Further Reading

- [Configuration.md](Configuration.md) -- MatrixSuite details, presets, and
  custom metric sections (shared by Node and browser)
- [Node.md](Node.md) -- Worker mode and external debugger attachment
- [Browser.md](Browser.md) -- Comparing variants in the browser, bench function
  and page-load modes, completion signals, CDP flow
- [Profiling.md](Profiling.md) -- Allocation sampling, GC stats, V8 flags,
  Perfetto export
- [Statistics.md](Statistics.md) -- Batches, block bootstrap, paired
  comparison, the verdict rule
- [Calibration.md](Calibration.md) -- Sizing runs and measuring the noise
  floor
- [README-tachometer.md](README-tachometer.md) -- Coming from tachometer

# Benchforge

Benchforge helps you make faster JavaScript programs with integrated tools for
benchmarking and performance analysis in Node.js and Chrome, including features
designed specifically for analyzing garbage-collected programs.

Garbage collection is intermittent and infrequent, which makes it harder to
identify true performance issues. Typical perf tools isolate microbenchmarks
from GC, but that hides a key part of real-world performance. Intermittent
events also lead to statistically skewed measurement distributions. Perf tools
that assume normal distributions and noise-free test runs can easily create
misleading false-positive performance reports. Benchforge captures a truer
picture of garbage-collected programs:

- **GC-aware statistics** -- bootstrap confidence intervals account for GC
  variance instead of hiding it.
- **Heap allocation profiling** -- see which functions allocate the most,
  including short-lived objects already collected.
- **GC collection reports** -- allocation rates, scavenge/full GC counts,
  promotion %, and pause times per iteration.
- **Visualization** -- distribution plots, icicle charts for allocators, source
  annotations with allocation and call count metrics.
- **Archive** -- save traces and source code together to share with your team.

## Timing Distributions
<img width="326" height="363" alt="stats with distribution curves" src="https://github.com/user-attachments/assets/532702bd-faa1-4cb3-8b33-ad5409631427" />

## Heap Allocation
Explore memory _allocation_ per function:
<img width="4444" height="2706" alt="allocation view" src="https://github.com/user-attachments/assets/6d4e2dee-bb72-41ce-a71d-d036bebedb3d" />

## Benchmark Iteration Time Series
<img width="387" height="306" alt="time series" src="https://github.com/user-attachments/assets/f5676b64-7906-422b-aef3-4eedc325c422" />

## Source Code Annotated with Performance Info
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

For suites with multiple benchmarks, groups, and baseline comparison, see
[Node.md](Node.md).

## Quick Start: Browser

`benchforge --url <page>` opens Chromium and runs your program.

You can time any page without modification, and compare against a baseline.

```bash
benchforge --url http://localhost:5173 --baseline-url http://localhost:5174 \
  --gc-stats --batches 20 --iterations 10 --headless
```

If you export your test function as `window.__bench`, benchforge can run
multiple iterations in the same tab, which helps reveal the accumulated effect
of heap allocation over time. Tests also run faster.

```html
<!-- bench function mode -->
<script>
window.__bench = () => {
  const arr = Array.from({ length: 10000 }, () => Math.random());
  arr.sort((a, b) => a - b);
};
</script>
```

See [Browser.md](Browser.md) for setup patterns, completion signals, and the CDP
flow.

## CLI Overview

Core flags for common workflows. Run `benchforge --help` for the full list.

| Flag | What it does |
|------|-------------|
| `--gc-stats` | GC allocation/collection stats |
| `--alloc` | Heap allocation sampling attribution |
| `--profile` | V8 CPU time sampling profiler |
| `--call-counts` | Per-function execution counts |
| `--stats <list>` | Timing columns to display (default: mean,p50,p99) |
| `--view` | Open interactive viewer in browser |
| `--archive [file]` | Archive profiles + sources to `.benchforge` file |
| `--duration <sec>` | Duration per batch (default: 0.642s) |
| `--iterations <n>` | Exact iterations (overrides --duration) |
| `--batches <n>` | Interleaved batches for baseline comparison |
| `--filter <pattern>` | Run only benchmarks matching regex/substring |
| `--url <url>` | Benchmark a browser page |
| `--baseline-url <url>` | A/B comparison in browser |
| `--equiv-margin <pct>` | Equivalence margin (default: 2%) |

See [Profiling.md](Profiling.md) for detailed profiling options and V8 flags.

## Key Concepts

### Batching

When comparing against a baseline, use `--batches` to interleave runs and reduce
ordering bias. Batch 0 is dropped by default (OS cache warmup). For reliable
comparisons, use 40+ batches.

```bash
benchforge sorting.ts --batches 40 --duration 2
```

See [Statistics.md](Statistics.md) for the full explanation of batched
execution, block bootstrap, and Tukey trimming.

### Baseline Comparison

When a group has a `baseline`, all benchmarks show Δ% with a bootstrap
confidence interval. The result is classified as faster, slower, equivalent, or
inconclusive based on the equivalence margin.

See [Statistics.md](Statistics.md#equivalence-margin) for how the four verdicts
work and how to calibrate the margin.

## Further Reading

- [Node.md](Node.md) -- Worker mode, module imports, custom metric sections,
  external debugger attachment
- [Browser.md](Browser.md) -- Bench function and page-load modes, completion
  signals, CDP flow
- [Profiling.md](Profiling.md) -- Allocation sampling, GC stats, V8 flags,
  Perfetto export
- [Statistics.md](Statistics.md) -- Column selection (`--stats`), bootstrap
  methods, batching, equivalence testing
- [README-tachometer.md](README-tachometer.md) -- Coming from tachometer

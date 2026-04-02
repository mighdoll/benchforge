# Benchforge

Traditional benchmarking tools either ignore GC or try to avoid it.
Benchforge captures GC impact.

Garbage collection makes benchmarks noisy — statistics like mean and max
stabilize poorly when collection is intermittent. Most tools work around
this by isolating microbenchmarks from GC, but that hides a key part of
real-world performance. And heap snapshots are useful for finding leaks,
but they can't show you where garbage is being generated.

- **Heap allocation profiling** — attribute allocations to call sites, including short-lived objects already collected by GC.
- **GC-aware statistics** — bootstrap confidence intervals and baseline comparison that account for GC variance instead of hiding it.
- **GC collection reports** — allocation rates, scavenge/full GC counts, promotion %, and pause times per iteration.

Also:
- **Zero-config CLI** — export a function, run `benchforge file.ts`.
- **Multiple export formats** — HTML reports, allocation flame charts, Perfetto traces, JSON.
- **Worker isolation** — node benchmarks run in child processes by default.
- **Browser support** — benchmark in Chromium via [Playwright + CDP](README-browser.md).

## Visualize garbage generation by function
<img width="4444" height="2706" alt="allocation view" src="https://github.com/user-attachments/assets/6d4e2dee-bb72-41ce-a71d-d036bebedb3d" />

## Installation

```bash
npm install benchforge
# or
pnpm add benchforge
```

## Quick Start

The simplest way to benchmark a function: export it as the default export and pass the file to `benchforge`.

```typescript
// my-bench.ts
export default function (): string {
  return "a" + "b";
}
```

```bash
benchforge my-bench.ts --gc-stats
```

### BenchSuite Export

For multiple benchmarks with groups, setup data, and baseline comparison, export a `BenchSuite`:

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

A `MatrixSuite` export (`.matrices`) is also recognized and runs via `matrixBenchExports`.

See `examples/simple-cli.ts` for a complete runnable example.

### Worker Mode with Module Imports

For worker mode, benchmarks can reference module exports instead of inline functions. This is essential for proper isolation since functions can't be serialized across process boundaries.

```typescript
const group: BenchGroup = {
  name: "Parser Benchmark",
  setup: () => loadTestData(),
  benchmarks: [{
    name: "parse",
    fn: () => {},  // placeholder - not used in worker mode
    modulePath: new URL("./benchmarks.ts", import.meta.url).href,
    exportName: "parse",
    setupExportName: "setup",  // optional: called once, result passed to exportName fn
  }],
};
```

When `setupExportName` is provided, the worker:
1. Imports the module
2. Calls `setup(params)` once (where params comes from `BenchGroup.setup()`)
3. Passes the setup result to each benchmark iteration

This eliminates manual caching boilerplate in worker modules.

## CLI Options

### Basic Options
- `--duration <seconds>` - Benchmark duration per test (default: 0.642s)
- `--iterations <count>` - Exact number of iterations (overrides --duration)
- `--filter <pattern>` - Run only benchmarks matching regex/substring
- `--worker` / `--no-worker` - Run in isolated worker process (default: true)
- `--inspect` - Run once for external profiler attach (single iteration, no warmup)
- `--warmup <count>` - Warmup iterations before measurement (default: 0)
- `--batches <n>` - Divide time into N interleaved batches for baseline comparison (default: 1)
- `--warmup-batch` - Include first batch in results (normally dropped to avoid OS cache warmup)
- `--equiv-margin <percent>` - Equivalence margin for baseline comparison (default: 2%)
- `--help` - Show all available options

### Allocation Profiling
- `--gc-stats` - Collect GC allocation/collection stats via --trace-gc-nvp
- `--alloc` - Allocation sampling attribution (includes garbage)
- `--alloc-interval <bytes>` - Sampling interval in bytes (default: 32768)
- `--alloc-depth <frames>` - Stack depth to capture (default: 64)
- `--alloc-rows <n>` - Number of top allocation sites to show (default: 20)

### Output Options
- `--view` - Open viewer in browser (report + allocation tabs)
- `--export-json <file>` - Export benchmark data to JSON
- `--export-perfetto <file>` - Export Perfetto trace file
- `--archive [file]` - Archive profile + report + sources to `.benchforge` file

## CLI Usage

### Filter benchmarks by name

```bash
benchforge my-bench.ts --filter "concat"
benchforge my-bench.ts --filter "^parse" --duration 2
```

### Profiling with external debuggers

Use `--inspect` to run benchmarks once for attaching external profilers:

```bash
# Use with Chrome DevTools profiler
node --inspect-brk $(which benchforge) my-bench.ts --inspect

# Use with other profiling tools
node --prof $(which benchforge) my-bench.ts --inspect
```

The `--inspect` flag executes exactly one iteration with no warmup, making it ideal for debugging and performance profiling.

### Key Concepts

**Setup Functions**: Run once per group and provide shared data to all benchmarks in that group. The data returned by setup is automatically passed as the first parameter to benchmark functions that expect it.

**Baseline Comparison**: When a baseline is specified, all benchmarks in the group show percentage differences (Δ%) compared to baseline. 

## Output

Results are displayed in a formatted table:

```
╔═════════════════╤═══════════════════════════════════════════╤═════════╗
║                 │                   time                    │         ║
║ name            │ mean  Δ% CI                    p50   p99  │ runs    ║
╟─────────────────┼───────────────────────────────────────────┼─────────╢
║ quicksort       │ 0.17  +5.5% [+4.7%, +6.2%]     0.15  0.63 │ 1,134   ║
║ insertion sort  │ 0.24  +25.9% [+25.3%, +27.4%]  0.18  0.36 │ 807     ║
║ --> native sort │ 0.16                           0.15  0.41 │ 1,210   ║
╚═════════════════╧═══════════════════════════════════════════╧═════════╝
```

- **Δ% CI**: Percentage difference from baseline with bootstrap confidence interval

### HTML

The HTML report displays:
- Histogram + KDE: Bar chart showing the distribution
- Time Series: Sample values over iterations, with heap allocation overlay when `--alloc` is enabled

```bash
# Open viewer in browser (report + allocation tabs)
benchforge my-bench.ts --view
# Press Ctrl+C to exit when done viewing
```

### Perfetto Trace Export

Export benchmark data as a Perfetto-compatible trace file for detailed analysis:

```bash
# Export trace file
benchforge my-bench.ts --export-perfetto trace.json

# With V8 GC events (automatically merged after exit)
node --expose-gc --trace-events-enabled --trace-event-categories=v8,v8.gc \
  benchforge my-bench.ts --export-perfetto trace.json
```

View the trace at https://ui.perfetto.dev by dragging the JSON file.

The trace includes:
- **Heap counter**: Continuous heap usage as a line graph
- **Sample markers**: Each benchmark iteration with timing
- **Pause markers**: V8 optimization pause points
- **V8 GC events**: Automatically merged after process exit (when run with `--trace-events-enabled`)

### Allocation Profile

View heap allocation profiles as flame charts in the unified viewer:

```bash
# Open viewer with allocation tab
benchforge my-bench.ts --alloc --view

# Archive profile + sources for sharing
benchforge my-bench.ts --alloc --archive
```

Each benchmark with a heap profile becomes a separate profile, with samples ordered temporally and weighted by allocation size in bytes.

### GC Statistics

Collect detailed garbage collection statistics via V8's `--trace-gc-nvp`:

```bash
# Collect GC allocation/collection stats (requires worker mode)
benchforge my-bench.ts --gc-stats
```

Adds these columns to the output table:
- **alloc/iter**: Bytes allocated per iteration
- **scav**: Number of scavenge (minor) GCs
- **full**: Number of full (mark-compact) GCs
- **promo%**: Percentage of allocations promoted to old generation
- **pause/iter**: GC pause time per iteration

### Allocation Sampling

For allocation profiling including garbage (short-lived objects), use `--alloc` mode which uses Node's built-in inspector API:

```bash
# Basic allocation sampling
benchforge my-bench.ts --alloc --iterations 100

# Smaller interval = more samples = better coverage of rare allocations
benchforge my-bench.ts --alloc --alloc-interval 4096 --iterations 100

# Verbose output with clickable file:// paths
benchforge my-bench.ts --alloc --alloc-verbose

# Control call stack display depth
benchforge my-bench.ts --alloc --alloc-stack 5
```

**CLI Options:**
- `--alloc` - Enable allocation sampling attribution
- `--alloc-interval <bytes>` - Sampling interval in bytes (default: 32768)
- `--alloc-depth <frames>` - Maximum stack depth to capture (default: 64)
- `--alloc-rows <n>` - Number of top allocation sites to show (default: 20)
- `--alloc-stack <n>` - Call stack depth to display (default: 3)
- `--alloc-verbose` - Show full file:// paths with line numbers (cmd-clickable)
- `--alloc-raw` - Dump every raw allocation sample (ordinal, size, stack)
- `--alloc-user-only` - Filter to user code only (hide node internals)

**Output (default compact):**
```
─── Heap profile: bevy_env_map ───
Heap allocation sites (top 20, garbage included):
  13.62 MB  recursiveResolve <- flattenTreeImport <- bindAndTransform
  12.36 MB  nextToken <- parseBlockStatements <- parseCompoundStatement
   5.15 MB  coverWithText <- finishElem <- parseVarOrLet

Total (all):       56.98 MB
Total (user-code): 28.45 MB
Samples: 1,842
```

**How V8 Heap Sampling Works:**

V8's sampling profiler uses Poisson-distributed sampling. When an allocation occurs, V8 probabilistically decides whether to record it based on the sampling interval. Key points:

1. **selfSize is scaled**: V8 doesn't report raw sampled bytes. It scales sample counts to estimate total allocations (`selfSize = size × count × scaleFactor`). This means changing `--alloc-interval` affects sample count and overhead, but the estimated total converges to the same value.

2. **Smaller intervals = better coverage**: With a smaller interval (e.g., 1024 vs 32768), you get more samples and discover more unique allocation sites, especially rare ones. The total estimate stays similar, but you see more of the distribution.

3. **User-code only**: The report filters out Node.js internals (`node:`, `internal/`). "Total (user-code)" shows filtered allocations; "Total (all)" shows everything.

4. **Measurement window**: Sampling covers benchmark module import + execution. Worker startup and framework init aren't captured (but do appear in `--gc-stats`).

5. **Sites are stack-unique**: The same function appears multiple times with different callers. For example, `nextToken` may show up in several entries with different call stacks, each representing a distinct allocation pattern.

**Limitations:**
- **Function-level attribution only**: V8 reports the function where allocation occurred, not the specific line. The line:column shown is where the function is *defined*.
- **Inlining shifts attribution**: V8 may inline a function into its caller, causing allocations to be reported against the caller instead. If attribution looks wrong, disable inlining to isolate: `node --js-flags='--no-turbo-inlining --no-maglev-inlining' benchforge ...` (or `--jitless` to disable JIT entirely, though this changes performance characteristics).
- **Statistical sampling**: Results vary between runs. More iterations = more stable results.
- **~50% filtered**: Node.js internals account for roughly half of allocations. Use "Total (all)" to see the full picture.

**When to use which:**
| Tool | Use When |
|------|----------|
| `--gc-stats` | Need total allocation/collection bytes, GC pause times |
| `--alloc` | Need to identify which functions allocate the most |
| Both | Cross-reference attribution with totals |

## Requirements

- Node.js 22.6+ (for native TypeScript support)
- Use `--expose-gc --allow-natives-syntax` flags for garbage collection monitoring and V8 native functions

## Adaptive Mode (Experimental)

Adaptive mode (`--adaptive`) automatically adjusts iteration count until measurements stabilize. The algorithm is still being tuned — use `--help` for available options.

## Interpreting Results

### Baseline Comparison (Δ% CI)
```
0.17  +5.5% [+4.7%, +6.2%]
```
The benchmark is 5.5% slower than baseline, with a bootstrap confidence interval of [+4.7%, +6.2%].

### Percentiles
```
p50: 0.15ms, p99: 0.27ms
```
50% of runs completed in ≤0.15ms and 99% in ≤0.27ms. Use percentiles when you care about consistency and tail latencies.

### Equivalence Testing

When comparing against a baseline, benchforge needs to distinguish three cases:
the code got faster, it got slower, or nothing meaningful changed.

Traditional CI-based testing only asks "does the confidence interval exclude zero?"
This can detect differences but can never confirm equivalence — with enough samples,
even trivial noise (ASLR, scheduler jitter) can push the CI away from zero,
leaving the result stuck at **Inconclusive** even when comparing identical code.

Benchforge uses an **equivalence margin** (`--equiv-margin`, default 2%) to resolve this.
The margin defines the smallest difference that matters. The CI is compared against
both zero and the margin to produce four verdicts:

```
         -margin       0       +margin
            |          |          |
    [---]   |          |          |        ==> FASTER  (CI excludes zero, beyond margin)
            |          |          | [---]  ==> SLOWER  (CI excludes zero, beyond margin)
            |   [----------]     |        ==> EQUIVALENT (CI within margin -- proven trivial)
            |      [--]          |        ==> EQUIVALENT (excludes zero, but within margin)
   [------------]  |             |        ==> INCONCLUSIVE (CI extends past margin, need more data)
```

- **Equivalent**: the entire CI fits within the margin. The difference is provably smaller
  than what matters, whether or not it's statistically significant.
- **Faster / Slower**: the CI excludes zero and extends beyond the margin. A real,
  meaningful change was detected.
- **Inconclusive**: the CI extends past the margin but doesn't clearly exclude zero.
  More batches would narrow the CI and resolve it.

The default margin of 2% is reasonable for most benchmarks. For higher precision, run a
self-comparison (identical baseline and current) to measure your system's noise floor,
then set the margin accordingly:

```bash
# Calibration: compare identical code, observe CI width
benchforge my-bench.ts --baseline --batches 50

# Use the observed noise floor as the margin
benchforge my-bench.ts --baseline --batches 50 --equiv-margin 1.5
```

## Warmup and Batching

### Batched Comparisons

When comparing against a baseline, use `--batches` to interleave runs and reduce ordering bias:

```bash
benchforge my-bench.ts --baseline --batches 10 --duration 2
```

With `--batches 10`, benchforge runs 10 alternating rounds of baseline and current, reversing the order on odd rounds to cancel out systematic effects. Results from all batches are merged for the final comparison.

**Warmup batch**: The first batch typically runs slower due to OS-level effects (page cache, CPU cache, memory allocator warmup). Since this affects both baseline and current but adds noise to the comparison, batch 0 is automatically dropped. Use `--warmup-batch` to include it.

For reliable comparisons, use 8+ batches. Fewer batches produce wider confidence intervals since the block bootstrap has fewer independent observations to work with.

### Two Kinds of Warmup

**JIT warmup** (V8 optimization): The first iterations of any benchmark run through V8's interpreter and lower optimization tiers before reaching peak performance. This warmup is part of real-world execution and is **included by default** — if your code takes 3.5ms including JIT compilation, that's what users experience. Use `--warmup <count>` to add warmup iterations before measurement if you specifically want steady-state throughput numbers.

**OS-level warmup** (page cache, CPU cache): The first batch in a multi-batch run pays a one-time cost for loading code into the OS page cache and CPU caches. Unlike JIT warmup, this is an artifact of the measurement harness — in production, code is almost always warm in the page cache. The first batch is **dropped by default** when `--batches > 1`.

| Warmup Type | Default | Override | Rationale |
|---|---|---|---|
| JIT (V8 tiers) | Included | `--warmup <n>` to skip | Part of real execution cost |
| OS (page cache) | Dropped (batch 0) | `--warmup-batch` to include | Measurement artifact |

## Understanding GC Time Measurements

### GC Duration in Node.js Performance Hooks

The `duration` field in GC PerformanceEntry records **stop-the-world pause time** - the time when JavaScript execution is actually blocked. This does NOT include:

1. **Concurrent GC work** done in parallel threads (concurrent marking, sweeping)
2. **Performance degradation** from CPU contention and cache effects
3. **Total GC overhead** including preparation and cleanup

### Key Findings

1. **Multiple GC Events**: A single `gc()` call can trigger multiple GC events that are recorded separately
2. **Incremental GC**: V8 breaks up GC work into smaller increments to reduce pause times
3. **Duration < Impact**: The recorded duration is often much less than the actual performance impact

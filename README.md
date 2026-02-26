# Benchforge

A TypeScript benchmarking library with CLI support for running performance tests.

## Browser Profiling

See [Browser Heap Profiling](README-browser.md) for profiling code running in a browser.

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
- `--time <seconds>` - Benchmark duration per test (default: 0.642s)
- `--iterations <count>` - Exact number of iterations (overrides --time)
- `--filter <pattern>` - Run only benchmarks matching regex/substring
- `--worker` / `--no-worker` - Run in isolated worker process (default: true)
- `--profile` - Run once for profiling (single iteration, no warmup)
- `--warmup <count>` - Warmup iterations before measurement (default: 0)
- `--help` - Show all available options

### Memory Profiling
- `--gc-stats` - Collect GC allocation/collection stats via --trace-gc-nvp
- `--heap-sample` - Heap sampling allocation attribution (includes garbage)
- `--heap-interval <bytes>` - Sampling interval in bytes (default: 32768)
- `--heap-depth <frames>` - Stack depth to capture (default: 64)
- `--heap-rows <n>` - Number of top allocation sites to show (default: 20)

### Output Options
- `--html` - Generate HTML report, start server, and open in browser
- `--export-html <file>` - Export HTML report to file
- `--json <file>` - Export benchmark data to JSON
- `--perfetto <file>` - Export Perfetto trace file

## CLI Usage

### Filter benchmarks by name

```bash
benchforge my-bench.ts --filter "concat"
benchforge my-bench.ts --filter "^parse" --time 2
```

### Profiling with external debuggers

Use `--profile` to run benchmarks once for attaching external profilers:

```bash
# Use with Chrome DevTools profiler
node --inspect-brk $(which benchforge) my-bench.ts --profile

# Use with other profiling tools
node --prof $(which benchforge) my-bench.ts --profile
```

The `--profile` flag executes exactly one iteration with no warmup, making it ideal for debugging and performance profiling.

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
- Time Series: Sample values over iterations
- Allocation Series: Per-sample heap allocation (requires `--heap-sample`)

```bash
# Generate HTML report, start server, and open in browser
benchforge my-bench.ts --html
# Press Ctrl+C to exit when done viewing
```

### Perfetto Trace Export

Export benchmark data as a Perfetto-compatible trace file for detailed analysis:

```bash
# Export trace file
benchforge my-bench.ts --perfetto trace.json

# With V8 GC events (automatically merged after exit)
node --expose-gc --trace-events-enabled --trace-event-categories=v8,v8.gc \
  benchforge my-bench.ts --perfetto trace.json
```

View the trace at https://ui.perfetto.dev by dragging the JSON file.

The trace includes:
- **Heap counter**: Continuous heap usage as a line graph
- **Sample markers**: Each benchmark iteration with timing
- **Pause markers**: V8 optimization pause points
- **V8 GC events**: Automatically merged after process exit (when run with `--trace-events-enabled`)

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

### Heap Sampling

For allocation profiling including garbage (short-lived objects), use `--heap-sample` mode which uses Node's built-in inspector API:

```bash
# Basic heap sampling
benchforge my-bench.ts --heap-sample --iterations 100

# Smaller interval = more samples = better coverage of rare allocations
benchforge my-bench.ts --heap-sample --heap-interval 4096 --iterations 100

# Verbose output with clickable file:// paths
benchforge my-bench.ts --heap-sample --heap-verbose

# Control call stack display depth
benchforge my-bench.ts --heap-sample --heap-stack 5
```

**CLI Options:**
- `--heap-sample` - Enable heap sampling allocation attribution
- `--heap-interval <bytes>` - Sampling interval in bytes (default: 32768)
- `--heap-depth <frames>` - Maximum stack depth to capture (default: 64)
- `--heap-rows <n>` - Number of top allocation sites to show (default: 20)
- `--heap-stack <n>` - Call stack depth to display (default: 3)
- `--heap-verbose` - Show full file:// paths with line numbers (cmd-clickable)

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

1. **selfSize is scaled**: V8 doesn't report raw sampled bytes. It scales sample counts to estimate total allocations (`selfSize = size × count × scaleFactor`). This means changing `--heap-interval` affects sample count and overhead, but the estimated total converges to the same value.

2. **Smaller intervals = better coverage**: With a smaller interval (e.g., 1024 vs 32768), you get more samples and discover more unique allocation sites, especially rare ones. The total estimate stays similar, but you see more of the distribution.

3. **User-code only**: The report filters out Node.js internals (`node:`, `internal/`). "Total (user-code)" shows filtered allocations; "Total (all)" shows everything.

4. **Measurement window**: Sampling covers benchmark module import + execution. Worker startup and framework init aren't captured (but do appear in `--gc-stats`).

5. **Sites are stack-unique**: The same function appears multiple times with different callers. For example, `nextToken` may show up in several entries with different call stacks, each representing a distinct allocation pattern.

**Limitations:**
- **Function-level attribution only**: V8 reports the function where allocation occurred, not the specific line. The line:column shown is where the function is *defined*.
- **Statistical sampling**: Results vary between runs. More iterations = more stable results.
- **~50% filtered**: Node.js internals account for roughly half of allocations. Use "Total (all)" to see the full picture.

**When to use which:**
| Tool | Use When |
|------|----------|
| `--gc-stats` | Need total allocation/collection bytes, GC pause times |
| `--heap-sample` | Need to identify which functions allocate the most |
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

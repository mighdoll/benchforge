# Profiling Guide

Benchforge includes several profiling instruments that work in both Node.js and
browser environments. Top-level flags enable each instrument; sub-options are
listed in `benchforge --help`.

| Flag | What it measures |
|------|-----------------|
| `--gc-stats` | Allocation rates, GC counts, promotion %, pause times |
| `--alloc` | Per-function heap allocation attribution (includes garbage) |
| `--profile` | V8 CPU time sampling per function |
| `--call-counts` | Per-function execution counts via V8 precise coverage |

Combine flags freely: `benchforge my-bench.ts --gc-stats --alloc --view`

In browser mode, the same flags work via CDP:
`benchforge --url http://localhost:5173 --alloc --gc-stats --view`

## GC Statistics

Collect garbage collection statistics per iteration:

```bash
benchforge my-bench.ts --gc-stats
```

In Node, this uses V8's `--trace-gc-nvp` and adds these columns:

| Column | Meaning |
|--------|---------|
| alloc/iter | Bytes allocated per iteration |
| scav | Number of scavenge (minor) GCs |
| full | Number of full (mark-compact) GCs |
| promo% | Percentage of allocations promoted to old generation |
| pause/iter | GC pause time per iteration |

In browser mode, collection counts and pause times come from CDP tracing.
`alloc/iter` and `promo%` are not available from CDP.

## Allocation Sampling

For per-function allocation profiling including garbage (short-lived objects
already collected), use `--alloc`. This uses V8's built-in sampling heap
profiler in both Node and browser.

```bash
benchforge my-bench.ts --alloc --iterations 100
```

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

View allocation profiles as interactive icicle charts:

```bash
benchforge my-bench.ts --alloc --view
benchforge my-bench.ts --alloc --archive   # save for sharing
```

### How V8 Heap Sampling Works

V8's sampling profiler uses Poisson-distributed sampling. When an allocation
occurs, V8 probabilistically decides whether to record it based on the sampling
interval. Key points:

1. **selfSize is scaled**: V8 doesn't report raw sampled bytes. It scales sample
   counts to estimate total allocations
   (`selfSize = size × count × scaleFactor`). This means changing the sampling
   interval affects sample count and overhead, but the estimated total converges
   to the same value.

2. **Smaller intervals = better coverage**: With a smaller interval (e.g., 1024
   vs 32768), you get more samples and discover more unique allocation sites,
   especially rare ones. The total estimate stays similar, but you see more of
   the distribution.

3. **User-code only**: The report filters out Node.js internals (`node:`,
   `internal/`). "Total (user-code)" shows filtered allocations; "Total (all)"
   shows everything.

4. **Measurement window**: Sampling covers benchmark module import + execution.
   Worker startup and framework init aren't captured (but do appear in
   `--gc-stats`).

5. **Sites are stack-unique**: The same function appears multiple times with
   different callers. For example, `nextToken` may show up in several entries
   with different call stacks, each representing a distinct allocation pattern.

### Limitations

- **Function-level attribution only**: V8 reports the function where allocation
  occurred, not the specific line. The line:column shown is where the function
  is *defined*.
- **Inlining shifts attribution**: V8 may inline a function into its caller,
  causing allocations to be reported against the caller instead. See
  [V8 Flags](#v8-flags) for how to disable inlining.
- **Statistical sampling**: Results vary between runs. More iterations = more
  stable results.
- **~50% filtered**: Node.js internals account for roughly half of allocations.
  Use "Total (all)" to see the full picture.

### When to Use Which

| Tool | Use When |
|------|----------|
| `--gc-stats` | Need total allocation/collection bytes, GC pause times |
| `--alloc` | Need to identify which functions allocate the most |
| Both | Cross-reference attribution with totals |

## Perfetto Trace Export

Export benchmark data as a Perfetto-compatible trace file for detailed analysis:

```bash
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
- **V8 GC events**: Automatically merged after process exit (when run with
  `--trace-events-enabled`)

## V8 Flags

These V8 flags are useful for heap allocation profiling. Pass them via
`node --js-flags='...'` for Node or `--chrome-args='--js-flags=...'` for browser
mode.

| Flag | Effect |
|------|--------|
| `--no-turbo-inlining --no-maglev-inlining` | See true allocation sites when inlining shifts attribution to the wrong function |
| `--no-inline-new` | Allocations go through the slow path, so the heap profiler catches every allocation site |
| `--sampling-heap-profiler-suppress-randomness` | Deterministic sample intervals for reproducible results |
| `--jitless` | Disable JIT entirely (changes performance characteristics) |

```bash
# Node
node --js-flags='--no-turbo-inlining --no-maglev-inlining' benchforge my-bench.ts --alloc

# Browser
benchforge --url http://localhost:5173 --alloc \
  --chrome-args='--js-flags=--no-turbo-inlining --no-maglev-inlining'
```

## Understanding GC Time Measurements

### GC Duration in Node.js Performance Hooks

The `duration` field in GC PerformanceEntry records **stop-the-world pause
time**, the time when JavaScript execution is actually blocked. This does NOT
include:

1. **Concurrent GC work** done in parallel threads (concurrent marking,
   sweeping)
2. **Performance degradation** from CPU contention and cache effects
3. **Total GC overhead** including preparation and cleanup

### Key Findings

1. **Multiple GC Events**: A single `gc()` call can trigger multiple GC events
   that are recorded separately
2. **Incremental GC**: V8 breaks up GC work into smaller increments to reduce
   pause times
3. **Duration < Impact**: The recorded duration is often much less than the
   actual performance impact

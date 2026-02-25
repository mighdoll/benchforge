# Browser Benchmarking

Benchmark and profile browser code using Playwright and Chrome DevTools Protocol.

`benchforge --url <page>` opens a Chromium instance, loads your page, and
auto-detects which mode to use based on what the page exports.

## Bench Function Mode (`window.__bench`)

Provide a function, benchforge handles iteration and timing:

```html
<script>
window.__bench = () => {
  const arr = Array.from({ length: 10000 }, () => Math.random());
  arr.sort((a, b) => a - b);
};
</script>
```

```bash
benchforge --url http://localhost:5173                    # default 0.642s time limit
benchforge --url http://localhost:5173 --iterations 200   # exact iteration count
benchforge --url http://localhost:5173 --time 3           # 3 second time limit
benchforge --url http://localhost:5173 --gc-stats         # add GC tracing
benchforge --url http://localhost:5173 --heap-sample      # add heap profiling
```

Output includes full statistics (mean, p50, p99) from per-iteration
`performance.now()` timing:

```
╔════════════╤══════════════════╤═══════╤══════╗
║            │       time       │       │      ║
║ name       │ mean  p50   p99  │ conv% │ runs ║
╟────────────┼──────────────────┼───────┼──────╢
║ index.html │ 2.49  2.50  2.90 │ —     │ 201  ║
╚════════════╧══════════════════╧═══════╧══════╝
```

Heap sampling and GC tracing wrap the entire iteration run (not
individual iterations), matching Node worker behavior.

## Lap Mode (`__start/__lap/__done`)

Your page controls when measurement begins and ends. Use this for
workloads that aren't a single callable function (setup, async flows,
rAF loops, multi-step operations):

```html
<script>
async function run() {
  await __start();          // reset timing origin, start instruments
  doExpensiveWork();
  await __done();           // stop instruments, collect results
}
run();
</script>
```

With laps for per-iteration statistics:

```html
<script>
async function run() {
  await __start();
  for (let i = 0; i < 100; i++) { doWork(); __lap(); }
  await __done();
  // ==> 100 samples with full statistics (mean, p50, p99)
}
run();
</script>
```

With rAF (excludes idle time between frames):

```html
<script>
async function frame() {
  await __start();             // reset timing origin, skip idle gap
  renderScene();
  __lap();               // sample = start-to-lap only
  if (more) requestAnimationFrame(frame);
  else await __done();
}
requestAnimationFrame(frame);
</script>
```

**Timing rule**: sample starts at the most recent `__start()` or `__lap()`,
whichever is later. Calling `__start()` again overrides the implicit start
from the previous `__lap()`.

**Instruments**: heap sampling and GC tracing run continuously from first
`__start()` to `__done()`. They cannot be paused between laps.

```bash
benchforge --url http://localhost:5173 --heap-sample --gc-stats
```

0 laps = single wall-clock measurement. N laps = full per-iteration statistics.

## How It Works

```
Page                              CLI (Playwright + CDP)
----                              ----------------------
                                  launch chromium, open CDP session
                                  start GC tracing (if --gc-stats)
                                  inject __start/__lap (in-page, zero CDP)
                                  expose __done (CDP binding)
                                  navigate to URL, wait for load

[bench function mode]
                                  detect window.__bench
                                  start heap sampling (if --heap-sample)
                                  inject iteration loop via page.evaluate
  __bench() x N  <----------->   collect timing samples
                                  stop heap sampling
                                  stop GC tracing, parse events

[lap mode]
  __start()      - - - - - - >   first call starts heap sampling (1 CDP)
  __lap() x N    (in-page)       collects timing samples, zero CDP
  __done()       ------------>   stop heap sampling, resolve promise
                                  stop GC tracing, parse events

                                  compute stats, print report
```

## CLI Options

| Option | Default | Description |
|--------|---------|-------------|
| `--url <url>` | | Page URL (enables browser mode) |
| `--time <seconds>` | 0.642 | Iteration time limit (bench function mode) |
| `--iterations <n>` | | Exact iteration count (bench function mode) |
| `--gc-stats` | false | Collect GC stats via CDP tracing |
| `--heap-sample` | false | Enable heap allocation profiling |
| `--heap-interval <bytes>` | 32768 | Sampling interval in bytes |
| `--heap-depth <frames>` | 64 | Stack depth to capture |
| `--heap-rows <n>` | 20 | Top allocation sites to show |
| `--heap-stack <n>` | 3 | Call stack depth to display |
| `--heap-verbose` | false | Show full URLs with line numbers |
| `--heap-user-only` | false | Filter to user code only |
| `--headless` | true | Run headless (`--no-headless` to show browser) |
| `--chrome-args=<flag>` | | Extra Chromium flags (repeatable, use `=` for values starting with `--`) |
| `--timeout <seconds>` | 60 | Max wait time |

Node-only flags (`--cpu`, `--trace-opt`, `--adaptive`, `--collect`, etc.)
are warned and ignored in browser mode.

## GC Stats (--gc-stats)

Uses CDP `Tracing` with `v8,v8.gc` categories to capture MinorGC/MajorGC events.

Available metrics:
- **collected** - total bytes freed across all GCs
- **scav** - young-gen scavenge count
- **full** - old-gen mark-compact count
- **pause** - total GC pause time (ms)

Note: Node's `--gc-stats` additionally reports alloc/iter, promoted, and survived
bytes (via `--trace-gc-nvp`), which aren't available from CDP tracing.

## Examples

See `examples/browser-bench/` (bench function mode) and
`examples/browser-heap/` (lap mode).

```bash
# bench function mode - timing statistics
benchforge --url file://$(pwd)/examples/browser-bench/index.html --time 1

# lap mode - heap profiling
benchforge --url file://$(pwd)/examples/browser-heap/index.html --heap-sample --gc-stats

# heap profiling with inlining disabled (see true allocation sites)
benchforge --url file://$(pwd)/examples/browser-heap/index.html --heap-sample \
  --chrome-args='--js-flags=--no-turbo-inlining --no-maglev-inlining'
```

Other useful V8 flags for heap profiling (`--js-flags=`):
- `--no-inline-new` — allocations go through the slow path, so the heap profiler catches every allocation site
- `--sampling-heap-profiler-suppress-randomness` — deterministic sample intervals for reproducible results

## Notes

- URLs in heap reports are `http://` paths instead of `file://` paths
- Chrome extensions and devtools internals are filtered as non-user code
- The V8 heap profiler format is identical between Node and Chrome
- Requires Playwright (`npx playwright install chromium` on first use)
- Page JS errors are captured and included in timeout error messages

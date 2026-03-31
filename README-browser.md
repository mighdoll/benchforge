# Browser Benchmarking

Benchmark and profile browser code using Playwright and Chrome DevTools Protocol.

`benchforge --url <page>` opens a Chromium instance, loads your page, and
auto-detects bench function vs lap mode based on what the page exports.
Use `--page-load` for profiling of unmodified pages.

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
benchforge --url http://localhost:5173 --duration 3       # 3 second time limit
benchforge --url http://localhost:5173 --gc-stats         # add GC tracing
benchforge --url http://localhost:5173 --alloc            # add allocation profiling
```

Output includes full statistics (mean, p50, p99) from per-iteration
`performance.now()` timing:

```
╔════════════╤══════════════════╤══════╗
║            │       time       │      ║
║ name       │ mean  p50   p99  │ runs ║
╟────────────┼──────────────────┼──────╢
║ index.html │ 2.49  2.50  2.90 │ 201  ║
╚════════════╧══════════════════╧══════╝
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
benchforge --url http://localhost:5173 --alloc --gc-stats
```

0 laps = single wall-clock measurement. N laps = full per-iteration statistics.

## Page-Load Mode (`--page-load`)

Profile any page without modifying it. No `__bench` or `__start/__done`
needed -- benchforge instruments before navigation, waits for completion,
and collects profiles:

```bash
benchforge --url http://localhost:5173 --page-load --alloc --call-counts
benchforge --url http://localhost:5173 --page-load --alloc --gc-stats --view
```

Output includes navigation timing from the page's Performance API:

```
╔════════════╤═══════════════════════╗
║            │      page load        ║
║ name       │  DCL    load    LCP   ║
╟────────────┼───────────────────────╢
║ index.html │ 42.3   85.7   120.4  ║
╚════════════╧═══════════════════════╝
```

### Completion Signal

By default, benchforge waits for `networkidle` (500ms with no in-flight
requests). This is usually fine. Use `--wait-for` when your SPA does
async work after initial load (data fetching, deferred rendering) and
you want profiles to capture the full render cycle:

| Value | Behavior |
|-------|----------|
| `"load"` | Navigation load event only |
| `"domcontentloaded"` | DOMContentLoaded event only |
| CSS selector (`#app`, `.loaded`, `[data-ready]`) | `page.waitForSelector()` after networkidle |
| JS expression (`window.appReady === true`) | `page.waitForFunction()` after networkidle |

```bash
# Wait for a specific element
benchforge --url http://localhost:5173 --page-load --wait-for "#app.loaded" --alloc

# Wait for a JS condition
benchforge --url http://localhost:5173 --page-load --wait-for "window.appReady" --alloc

# Just the load event, no idle wait
benchforge --url http://localhost:5173 --page-load --wait-for load --alloc
```

Using `--wait-for` implies `--page-load`, so you can omit the flag:

```bash
benchforge --url http://localhost:5173 --wait-for "#root" --alloc
```

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
                                  start allocation sampling (if --alloc)
                                  inject iteration loop via page.evaluate
  __bench() x N  <----------->   collect timing samples
                                  stop heap sampling
                                  stop GC tracing, parse events

[lap mode]
  __start()      - - - - - - >   first call starts heap sampling (1 CDP)
  __lap() x N    (in-page)       collects timing samples, zero CDP
  __done()       ------------>   stop heap sampling, resolve promise
                                  stop GC tracing, parse events

[page-load mode]
                                  start instruments (--alloc, --call-counts, etc.)
                                  navigate to URL
                                  wait for networkidle (or --wait-for)
                                  read navigation timing from page
                                  stop instruments, collect profiles

                                  compute stats, print report
```

## CLI Options

Browser-specific options:

| Option | Default | Description |
|--------|---------|-------------|
| `--url <url>` | | Page URL (enables browser mode) |
| `--page-load` | false | Passive page-load profiling (no `__bench`/`__start` needed) |
| `--wait-for <value>` | | Completion signal: CSS selector, JS expression, `load`, or `domcontentloaded` |
| `--headless` | true | Run headless (`--no-headless` to show browser) |
| `--chrome-args=<flag>` | | Extra Chromium flags (repeatable, use `=` for values starting with `--`) |
| `--timeout <seconds>` | 60 | Max wait time |

See [CLI Options](README.md#cli-options) for shared options (`--duration`, `--iterations`, `--alloc`, `--gc-stats`, `--view`, etc.).

Node-only flags (`--trace-opt`, `--adaptive`, `--collect`, etc.)
are warned and ignored in browser mode.

## GC Stats (--gc-stats)

Uses CDP `Tracing` with `v8,v8.gc` categories to capture MinorGC/MajorGC events.

Available metrics:
- **collected** - total bytes freed across all GCs
- **scav** - young-gen scavenge count
- **full** - old-gen mark-compact count
- **pause** - total GC pause time (ms)

Note: Node's `--gc-stats` additionally reports alloc/iter and promo%
(via `--trace-gc-nvp`), which aren't available from CDP tracing.

## Examples

See `examples/browser-bench/` (bench function mode),
`examples/browser-heap/` (lap mode), and
`examples/browser-page-load/` (page-load mode).

```bash
# bench function mode - timing statistics
benchforge --url file://$(pwd)/examples/browser-bench/index.html --duration 1

# lap mode - allocation profiling
benchforge --url file://$(pwd)/examples/browser-heap/index.html --alloc --gc-stats

# page-load mode - passive profiling
benchforge --url file://$(pwd)/examples/browser-page-load/index.html --page-load --alloc --call-counts --gc-stats

# allocation profiling with inlining disabled (see true allocation sites)
benchforge --url file://$(pwd)/examples/browser-heap/index.html --alloc \
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

# Browser Benchmarking

Benchmark and profile browser code using the Chrome DevTools Protocol.

`benchforge --url <page>` opens a Chromium instance, loads your page, and
auto-detects bench function vs page-load mode. If the page exports
`window.__bench`, benchforge iterates and times it. Otherwise it reloads in
page-load mode to profile the full navigation.

```bash
benchforge --url http://localhost:5173
benchforge --url http://localhost:5173 --baseline-url http://localhost:5174
benchforge --url http://localhost:5173 --alloc --gc-stats --view
```

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

Heap sampling and GC tracing wrap the entire iteration run (not individual
iterations), matching Node worker behavior.

### Setup

Code that runs during page load executes before timing starts. Use closures to
pass setup results to `__bench`:

```html
<script type="module">
  const data = await fetch("/data.json").then(r => r.json());
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  // only this function is timed
  window.__bench = () => renderScene(ctx, data);
</script>
```

## Page-Load Mode

Profile any page without modifying it. If benchforge doesn't find `__bench` on
the page, it automatically reloads in page-load mode. Using `--page-load`
explicitly skips the probe navigation (one fewer page load).


Output includes navigation timing from the page's Performance API:

```
╔═════════════╤═══════════════════╤═══════════════════╤═══════════════════╤══════╗
║             │       DCL         │       load        │       LCP         │      ║
║ name        │ mean  p50    p99  │ mean  p50    p99  │ mean  p50    p99  │ runs ║
╟─────────────┼───────────────────┼───────────────────┼───────────────────┼──────╢
║ index.html  │ 38ms  37ms  42ms  │ 45ms  44ms  51ms  │ 62ms  60ms  78ms │  90  ║
╚═════════════╧═══════════════════╧═══════════════════╧═══════════════════╧══════╝
```

### Completion Signal

By default, benchforge waits for the `load` event. Use `--wait-for` when your
SPA does async work after initial load (data fetching, deferred rendering) and
you want profiles to capture the full render cycle:

| Value | Behavior |
|-------|----------|
| `"domcontentloaded"` | DOMContentLoaded event only |
| CSS selector (`#app`, `.loaded`, `[data-ready]`) | `page.waitForSelector()` after load |
| JS expression (`window.appReady === true`) | `page.waitForFunction()` after load |

```bash
# Wait for a specific element
benchforge --url http://localhost:5173 --wait-for "#app.loaded" --alloc

# Wait for a JS condition
benchforge --url http://localhost:5173 --wait-for "window.appReady" --alloc
```

Using `--wait-for` implies `--page-load`, so you can omit the flag.

## How It Works

```
Page                              CLI (CDP)
----                              ----------------------
                                  launch chromium, open CDP session
                                  start GC tracing (if --gc-stats)
                                  navigate to URL, wait for load

[bench function mode]
                                  detect window.__bench
                                  start allocation sampling (if --alloc)
                                  inject iteration loop via page.evaluate
  __bench() x N  <----------->   collect timing samples
                                  stop heap sampling
                                  stop GC tracing, parse events

[page-load mode]
                                  start instruments (--alloc, --call-counts, etc.)
                                  navigate to URL
                                  wait for load (or --wait-for)
                                  read navigation timing from page
                                  stop instruments, collect profiles

                                  compute stats, print report
```

## Examples

See [`examples/`](https://github.com/mighdoll/benchforge/tree/main/examples).

## Chrome Flags

Pass V8 flags to Chrome via `--chrome-args='--js-flags=...'`. See
[V8 Flags](Profiling.md#v8-flags) for useful flags for heap profiling.

## Notes

- URLs in heap reports are `http://` paths instead of `file://` paths
- Chrome extensions and devtools internals are filtered as non-user code
- Page JS errors are captured and included in timeout error messages
- Note: Node's `--gc-stats` additionally reports alloc/iter and promo% (via
  `--trace-gc-nvp`), which aren't available from CDP tracing. We still get
  collection and pause count via CDP.

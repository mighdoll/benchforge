# Node.js Benchmarking

Node benchmarks run in isolated child processes (workers) by default. Pass a
TypeScript file exporting a default function or `MatrixSuite`, and benchforge
handles the rest.

```bash
benchforge my-bench.ts --gc-stats
```

For the suite model (cases x variants), presets, and custom metric sections --
which apply to both Node and browser runs -- see
[Configuration.md](Configuration.md). This page covers what is specific to
running in Node: worker isolation, attaching external debuggers, and version
requirements.

## Worker Mode

Workers provide process-level isolation: each benchmark runs in a fresh child
process with its own heap. This is the default (`--no-worker` to disable).

Because functions can't cross a process boundary, an inline variant is serialized
(via `fn.toString()`) and reconstructed in the worker, so it must be
self-contained: a closure that captures a local variable won't have it in the
worker. Two ways to run code that needs imports or shared state across
iterations:

- **Variant directory** (`variantDir`): a directory of `.ts` files, each
  re-imported fresh in its worker so it can `import` whatever it needs. See
  [Configuration.md](Configuration.md#variants-that-need-imports-or-shared-state)
  for the `run`/`setup` contract.
- **`--no-worker`**: run in-process, where inline closures work but there is no
  heap isolation between variants.

## Profiling with External Debuggers

Use `--inspect` to run benchmarks once for attaching external profilers:

```bash
# Use with Chrome DevTools profiler
node --inspect-brk --expose-gc $(which benchforge) my-bench.ts --inspect

# Use with other profiling tools
node --prof --expose-gc $(which benchforge) my-bench.ts --inspect
```

The `--inspect` flag executes exactly one iteration with no warmup and runs the
benchmark **in-process** (not in a worker), so the profiler attached to the node
command sees the benchmark code itself. Because there is no worker to auto-add
the V8 flags, pass `--expose-gc` yourself if the benchmark forces GC
(`--gc-force`), and `--allow-natives-syntax` if it uses V8 intrinsics.

## Requirements

- Node.js 22.6+ (for native TypeScript support)

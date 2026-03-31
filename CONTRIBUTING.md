# Contributing to Benchforge

## Getting Started

```bash
pnpm install
pnpm build        # tsdown (lib) + vite (viewer)
pnpm test         # unit/integration tests
```

Requires Node 22.6+. During development, `bin/benchforge` runs TypeScript directly, no build step needed to test CLI changes.

## Project Layout

```
src/
  core/        benchmark definitions, result types
  runners/     timing loop, adaptive sampling, worker isolation
  profiling/   heap/CPU sampling (Node inspector), browser (Playwright + CDP)
  matrix/      case x variant matrix benchmarks
  stats/       bootstrap CI, permutation tests, percentiles
  report/      terminal tables, formatters, HTML data prep
  export/      JSON, Speedscope, Perfetto, .benchforge archive
  cli/         argument parsing, orchestration, filtering
  viewer/      Vite SPA — tabs, plots, source viewer (separate build)
    plots/     client-side charts (excluded from tsconfig, uses DOM types)
examples/      runnable benchmarks for Node and browser modes
```

The engine (`src/`) and viewer (`src/viewer/`) are built separately: tsdown compiles the library and CLI, Vite bundles the viewer.

## Key Scripts

| Script | What it does |
|---|---|
| `pnpm build` | Full build (tsdown lib + vite viewer) |
| `pnpm dev:viewer` | Vite dev server on :5173 |
| `pnpm test` | Unit/integration tests (vitest, --expose-gc) |
| `pnpm test:e2e` | Browser e2e tests (needs Playwright) |
| `pnpm typecheck` | Type check with tsgo |
| `pnpm fix` | Biome lint + format |
| `pnpm prepush` | Full validation: fix, typecheck, test, build, e2e. |
| `pnpm example:node` | Run a sample benchmark with the viewer  (also other examples in package.json) |

## Contribution Areas

### Viewer

The viewer lives in `src/viewer/` and is built by Vite. Run `pnpm dev:viewer` for hot reload.

The data contract between engine and viewer is `ReportData` in `src/viewer/ReportData.ts`. Plots live in `src/viewer/plots/` and use D3/Observable Plot (DOM types, separate from the main tsconfig).

The built viewer (`dist/viewer/`) is a static SPA. You can deploy it anywhere.
Without the cli server it shows a drop zone for `.benchforge` archives, or accepts `?url=` to load one from a URL.

Good starting points: new plot types, UI fixes.

### Alternate Runners

The runner abstraction is the `BenchRunner` interface in `src/runners/BenchRunner.ts` — a single method:

```ts
runBench(benchmark, options, params?) → Promise<MeasuredResults[]>
```

Implement this interface and register it in `src/runners/CreateRunner.ts`. The rest of the pipeline (reporting, export, viewer) works unchanged. This is useful for environments without Playwright, for wrapping other benchmark libraries, or for custom measurement strategies.

### Generating `.benchforge` Files

The `.benchforge` archive is a JSON file that the viewer can open standalone. Any external tool can produce one. The type is `ArchiveData` in `src/viewer/Providers.ts`:

```json
{
  "schema": 1,
  "report": { "groups": [...], "metadata": {...} },
  "profile": null,
  "timeProfile": null,
  "sources": {},
  "metadata": { "timestamp": "...", "benchforgeVersion": "..." }
}
```

The `report` field follows the `ReportData` shape (`src/viewer/ReportData.ts`). Allocation and time profiles use the Speedscope format. See `src/viewer/ViewerServer.ts` for how archives are assembled server-side.

Open an archive with: `benchforge view file.benchforge`

## Tests

- Test fixtures in `src/test/fixtures/`
- E2e tests require Playwright (`pnpm test:e2e`)
- Run `pnpm prepush` before pushing

## Style

- **Biome** for formatting and linting: `pnpm fix`
- **tsgo** for type checking: `pnpm typecheck`

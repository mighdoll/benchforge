import type { BenchMatrix, MatrixSuite } from "../src/index.ts";

// Copying an array three idiomatic ways, measured against the spread baseline.
// All three allocate a fresh array each iteration (so the heap/alloc profile has
// data). Against `[...arr]`, `slice()` is much faster (~34%) while `Array.from()`
// is equivalent: one card holding both a decisive win and a genuine no-difference,
// which is the mix the CI and shift function are there to tell apart. Keep the
// default 2% margin -- this benchmark's own noise floor sits near 1%, and a tighter
// margin turns the equivalent variant into a merely inconclusive one.
//
// An iteration here costs only ~30us, so the run fits ~170k of them per variant.
// That makes it a poor fit for --gc-stats: it triggers tens of thousands of
// scavenges, and every one is recorded, which bloats an archive to ~80MB (and would
// bury the time-series GC overlay under a wall of markers). Leave GC stats to
// pipeline-ab and prealloc-ab, whose collections are few enough to read. Here,
// --max-samples subsamples the retained timings without shortening the run.
//
//   benchforge examples/simple-cli.ts --batches 50 --duration 0.3 --max-samples 400
const copying: BenchMatrix<number[]> = {
  name: "Array Copy (50,000 numbers)",
  caseData: {
    numbers: () => Array.from({ length: 50_000 }, () => Math.random()),
  },
  variants: {
    slice: arr => arr.slice(),
    spread: arr => [...arr],
    from: arr => Array.from(arr),
  },
  baselineVariant: "spread",
};

const suite: MatrixSuite = {
  name: "Performance Tests",
  matrices: [copying],
};

export default suite;

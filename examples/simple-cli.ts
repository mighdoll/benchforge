import type { BenchMatrix, MatrixSuite } from "../src/index.ts";

// Copy an array three idiomatic ways, measured against the spread baseline.
// slice() is a clear win over [...arr] while Array.from() is equivalent to it:
// one card holding both a decisive difference and a genuine no-difference -- the
// mix the CI and shift function are there to tell apart.
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

import type { BenchMatrix, MatrixSuite } from "../src/index.ts";

// Copying an array three idiomatic ways, measured against the spread baseline.
// All three allocate a fresh array each iteration (so the heap/alloc profile has
// data); the differences are subtle, which is the point. Against `[...arr]`,
// `slice()` is moderately faster and `Array.from()` is equivalent -- a mix the CI
// and shift function are there to tell apart.
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

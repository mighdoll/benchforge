import type { BenchMatrix, MatrixSuite } from "../src/index.ts";

interface Row {
  id: number;
  name: string;
}

interface Out {
  id: number;
  label: string;
}

// Build the same retained array of 100k objects, differing only in how the result
// array is grown: push (the backing store is reallocated as it grows) vs a
// preallocated array written by index. Unlike pipeline-ab, the whole distribution
// shifts together rather than only the tail.
//
//   benchforge examples/prealloc-ab.ts --gc-stats --batches 50 --iterations 20 --equiv-margin 0.5
const build: BenchMatrix<Row[]> = {
  name: "Build 100k objects",
  caseData: {
    rows: () => makeRows(100_000),
  },
  variants: {
    push: rows => {
      const out: Out[] = [];
      for (const r of rows) {
        let h = 2166136261;
        for (let i = 0; i < r.name.length; i++) {
          h ^= r.name.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        out.push({ id: r.id, label: (h >>> 0).toString(36) });
      }
      return out;
    },
    prealloc: rows => {
      const out: Out[] = new Array(rows.length);
      for (let j = 0; j < rows.length; j++) {
        const r = rows[j];
        let h = 2166136261;
        for (let i = 0; i < r.name.length; i++) {
          h ^= r.name.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        out[j] = { id: r.id, label: (h >>> 0).toString(36) };
      }
      return out;
    },
  },
  baselineVariant: "push",
};

const suite: MatrixSuite = {
  name: "push vs preallocated array",
  matrices: [build],
};

function makeRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `row-${i}-${(i * 2654435761) >>> 0}`,
  }));
}

export default suite;

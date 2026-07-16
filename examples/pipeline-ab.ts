import type { BenchMatrix, MatrixSuite } from "../src/index.ts";

// The same record transform two ways over 100k rows with identical per-element
// work: chained (map -> filter -> map, allocating throwaway intermediates) vs a
// single loop that allocates only the result. The extra garbage makes chained take
// major GCs the loop avoids, so the difference lives in the tail (p90/p99 where the
// GC pauses land), not the average.
//
//   benchforge examples/pipeline-ab.ts --gc-stats --batches 50 --iterations 25 --equiv-margin 0.5
interface Row {
  id: number;
  name: string;
  score: number;
}

interface Out {
  id: number;
  label: string;
}

const transform: BenchMatrix<Row[]> = {
  name: "Transform 100k records",
  caseData: {
    rows: () => makeRows(100_000),
  },
  variants: {
    loop: rows => {
      const out: Out[] = [];
      for (const r of rows) {
        if (r.score * 2 <= 0.5) continue;
        let h = 2166136261;
        for (let i = 0; i < r.name.length; i++) {
          h ^= r.name.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        out.push({ id: r.id, label: (h >>> 0).toString(36) });
      }
      return out;
    },
    chained: rows =>
      rows
        .map(r => ({ ...r, score: r.score * 2 }))
        .filter(r => r.score > 0.5)
        .map(r => {
          let h = 2166136261;
          for (let i = 0; i < r.name.length; i++) {
            h ^= r.name.charCodeAt(i);
            h = Math.imul(h, 16777619);
          }
          return { id: r.id, label: (h >>> 0).toString(36) };
        }),
  },
  baselineVariant: "loop",
};

const suite: MatrixSuite = {
  name: "chained pipeline vs single loop",
  matrices: [transform],
};

function makeRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `row-${i}-${(i * 2654435761) >>> 0}`,
    score: Math.random(),
  }));
}

export default suite;

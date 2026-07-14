import type { BenchMatrix, MatrixSuite } from "../src/index.ts";

// The same record transform two ways over 100k rows, both doing an identical (and
// moderately expensive) per-element string hash. `chained` runs map -> filter -> map,
// allocating two throwaway intermediate arrays before the result; `loop` does one
// pass and allocates only the result. The shared per-element work keeps the means
// within ~20%, but the extra garbage makes chained promote more and take major GCs
// the loop avoids -- so the change by percentile chart stays modest in the body and
// fans out sharply at p90/p99 where the GC pauses land. A good illustration of a
// difference that lives in the tail, not the average.
//
// Bound the batches by --iterations, not --duration: the GC columns (collected,
// scav, full) are run totals, so under a time budget the slower variant runs fewer
// iterations and its extra garbage goes undercounted.
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

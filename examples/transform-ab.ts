import type { BenchMatrix, MatrixSuite } from "../src/index.ts";

// Build the SAME array of 200k transformed objects two ways -- Array#map vs a
// preallocated indexed loop -- with identical per-element work (a string hash) and
// identical allocation. The only difference is the map callback overhead: a small
// (~2%) but real and reproducible edge for the loop. That is the point of the
// example -- a difference this small is exactly what coarser tools dismiss as noise.
// Run with the equivalence margin set to the machine's measured noise floor (well
// under 1%, e.g. --equiv-margin 0.5) and benchforge resolves it as a conclusive
// "better", not an "uncertain" straddle of the default 2% band. The retained result
// array is promoted to old space, so major GCs also show up in the GC table.
//
//   benchforge examples/transform-ab.ts --gc-stats --batches 50 --duration 0.3 --equiv-margin 0.5
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
  name: "Transform 200k records",
  caseData: {
    rows: () => makeRows(200_000),
  },
  variants: {
    map: rows =>
      rows.map(r => {
        let h = 2166136261;
        for (let i = 0; i < r.name.length; i++) {
          h ^= r.name.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        return { id: r.id, label: (h >>> 0).toString(36) };
      }),
    loop: rows => {
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
  baselineVariant: "map",
};

const suite: MatrixSuite = {
  name: "map vs manual loop",
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

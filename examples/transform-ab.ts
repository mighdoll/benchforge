import type { BenchMatrix, MatrixSuite } from "../src/index.ts";

// Build the SAME array of 200k transformed objects two ways -- Array#map vs a
// preallocated indexed loop -- with identical per-element work (a string hash) and
// identical allocation. The only difference is the map callback overhead: small but
// real and reproducible. That is the point: a difference this small is exactly what
// coarser tools dismiss as noise.
//
//   benchforge examples/transform-ab.ts --gc-stats --batches 40 --iterations 40 --equiv-margin 1
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

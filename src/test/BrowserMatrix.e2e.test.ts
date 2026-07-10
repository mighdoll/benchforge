import path from "node:path";
import { expect, test } from "vitest";
import type { BenchMatrix } from "../matrix/BenchMatrix.ts";
import { runMatrixBrowser } from "../matrix/MatrixBrowserRunner.ts";
import { profileBrowser } from "../profiling/browser/BrowserProfiler.ts";
import { launchChrome } from "../profiling/browser/ChromeLauncher.ts";

const examplesDir = path.resolve(import.meta.dirname!, "../../examples");
// Any page works as a harness; inject overrides the page's own __bench.
const harness = `file://${examplesDir}/browser-bench/index.html`;

test("inject mode times a serialized variant against a harness page", {
  timeout: 30000,
}, async () => {
  const chrome = await launchChrome({ headless: true });
  try {
    const result = await profileBrowser({
      url: harness,
      headless: true,
      chrome,
      maxIterations: 100,
      inject: {
        runCode:
          "(d) => { let s = 0; for (let i = 0; i < d.n; i++) s += Math.sqrt(i); return s; }",
        caseData: { n: 500 },
      },
    });
    expect(result.samples?.length).toBe(100);
    for (const s of result.samples!) expect(s).toBeGreaterThanOrEqual(0);
  } finally {
    await chrome.close();
  }
});

test("runMatrixBrowser drives cases x variants over a persistent Chrome", {
  timeout: 60000,
}, async () => {
  // Typing the matrix lets the variant params infer without annotations, so
  // fn.toString() stays valid JS for in-page eval.
  const matrix: BenchMatrix<{ n: number }> = {
    name: "sqrtloop",
    caseData: { small: { n: 500 }, large: { n: 2000 } },
    variants: {
      forloop: d => {
        let s = 0;
        for (let i = 0; i < d.n; i++) s += Math.sqrt(i);
        return s;
      },
      whileloop: d => {
        let s = 0;
        let i = 0;
        while (i < d.n) {
          s += Math.sqrt(i);
          i++;
        }
        return s;
      },
    },
    baselineVariant: "forloop",
  };

  const results = await runMatrixBrowser(matrix, {
    iterations: 150,
    batches: 3,
    browser: { url: harness, headless: true },
  });

  expect(results.variants.map(v => v.id)).toEqual(["forloop", "whileloop"]);
  for (const variant of results.variants) {
    expect(variant.cases.map(c => c.caseId)).toEqual(["small", "large"]);
    for (const c of variant.cases) {
      expect(c.measured.samples.length).toBeGreaterThan(0);
      // 3 batches minus the dropped warmup batch => 2 blocks (block-bootstrap path).
      expect(c.measured.batchOffsets?.length).toBe(2);
    }
  }

  // The non-baseline variant is paired against the forloop baseline per case.
  const whileloop = results.variants.find(v => v.id === "whileloop")!;
  expect(whileloop.cases[0].baseline).toBeDefined();
  expect(whileloop.cases[0].baselineId).toBe("forloop");
  expect(whileloop.cases[0].deltaPercent).toBeTypeOf("number");
});

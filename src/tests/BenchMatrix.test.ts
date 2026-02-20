import { expect, test } from "vitest";
import type { BenchMatrix, StatefulVariant } from "../BenchMatrix.ts";
import { isStatefulVariant, runMatrix } from "../BenchMatrix.ts";
import { loadCaseData, loadCasesModule } from "../matrix/CaseLoader.ts";
import { discoverVariants, loadVariant } from "../matrix/VariantLoader.ts";

test("inline variants, no cases", async () => {
  const matrix: BenchMatrix = {
    name: "Test",
    variants: {
      fast: () => {},
      slow: () => {
        let _x = 0;
        for (let i = 0; i < 1000; i++) _x++;
      },
    },
  };
  const results = await runMatrix(matrix, { iterations: 10 });
  expect(results.name).toBe("Test");
  expect(results.variants).toHaveLength(2);
  expect(results.variants.map(v => v.id).sort()).toEqual(["fast", "slow"]);
  for (const variant of results.variants) {
    expect(variant.cases).toHaveLength(1);
    expect(variant.cases[0].caseId).toBe("default");
    expect(variant.cases[0].measured.samples.length).toBeGreaterThan(0);
  }
});

test("inline variants with cases", async () => {
  const matrix: BenchMatrix<string> = {
    name: "Test",
    variants: {
      upper: (s: string) => s.toUpperCase(),
      lower: (s: string) => s.toLowerCase(),
    },
    cases: ["Hello", "World"],
  };
  const results = await runMatrix(matrix, { iterations: 10 });
  expect(results.variants).toHaveLength(2);
  for (const variant of results.variants) {
    expect(variant.cases).toHaveLength(2);
    expect(variant.cases.map(c => c.caseId)).toEqual(["Hello", "World"]);
  }
});

test("stateful variant", async () => {
  const stateful = {
    setup: (id: string) => ({ prepared: id.toUpperCase() }),
    run: (state: { prepared: string }) => state.prepared.toLowerCase(),
  };
  const matrix: BenchMatrix<string> = {
    name: "Test",
    variants: { stateful },
    cases: ["a", "b"],
  };
  const results = await runMatrix(matrix, { iterations: 10 });
  expect(results.variants).toHaveLength(1);
  expect(results.variants[0].id).toBe("stateful");
  expect(results.variants[0].cases).toHaveLength(2);
});

test("async setup in stateful variant", async () => {
  const asyncSetup = {
    setup: async (n: string) => {
      await Promise.resolve();
      return { value: Number(n) * 2 };
    },
    run: (state: { value: number }) => state.value + 1,
  };
  const matrix: BenchMatrix<string> = {
    name: "AsyncTest",
    variants: { asyncSetup },
    cases: ["1", "2"],
  };
  const results = await runMatrix(matrix, { iterations: 10 });
  expect(results.variants).toHaveLength(1);
  expect(results.variants[0].cases).toHaveLength(2);
});

test("isStatefulVariant type guard", () => {
  const fn = () => {};
  const stateful: StatefulVariant = { setup: () => ({}), run: () => {} };

  expect(isStatefulVariant(fn)).toBe(false);
  expect(isStatefulVariant(stateful)).toBe(true);
});

test("error when no variants provided", async () => {
  const matrix: BenchMatrix = { name: "Empty" };
  await expect(runMatrix(matrix)).rejects.toThrow(
    "requires either 'variants' or 'variantDir'",
  );
});

const discoverUrl = `file://${import.meta.dirname}/fixtures/discover/`;

test("discoverVariants finds .ts files", async () => {
  const variants = await discoverVariants(discoverUrl);
  expect(variants.sort()).toEqual(["fast", "slow"]);
});

test("loadVariant loads stateless variant", async () => {
  const variant = await loadVariant(discoverUrl, "fast");
  expect(typeof variant).toBe("function");
});

test("loadVariant loads stateful variant", async () => {
  const statefulUrl = `file://${import.meta.dirname}/fixtures/stateful/`;
  const variant = await loadVariant(statefulUrl, "stateful");
  expect(typeof variant).toBe("object");
  expect(typeof (variant as any).setup).toBe("function");
  expect(typeof (variant as any).run).toBe("function");
});

test("loadVariant throws when run is missing", async () => {
  const invalidUrl = `file://${import.meta.dirname}/fixtures/invalid/`;
  await expect(loadVariant(invalidUrl, "bad")).rejects.toThrow(
    "must export 'run'",
  );
});

const workerFixturesUrl = `file://${import.meta.dirname}/fixtures/worker/`;

test("runMatrix with variantDir discovers and runs variants", async () => {
  const matrix: BenchMatrix = {
    name: "DirTest",
    variantDir: workerFixturesUrl,
    cases: ["a"],
  };
  const results = await runMatrix(matrix, { iterations: 5 });
  expect(results.name).toBe("DirTest");
  const variantIds = results.variants.map(v => v.id).sort();
  expect(variantIds).toEqual(["fast", "slow"]);
});

test("runMatrix with variantDir runs each variant in isolated worker", async () => {
  const matrix: BenchMatrix = {
    name: "IsolationTest",
    variantDir: workerFixturesUrl,
    cases: ["test"],
  };
  const results = await runMatrix(matrix, { iterations: 3 });
  expect(results.variants).toHaveLength(2);
  for (const variant of results.variants) {
    expect(variant.cases).toHaveLength(1);
    expect(variant.cases[0].measured.samples.length).toBeGreaterThan(0);
  }
});

const casesFixturesUrl = `file://${import.meta.dirname}/fixtures/cases`;
const casesModuleUrl = `${casesFixturesUrl}/cases.ts`;
const asyncCasesUrl = `${casesFixturesUrl}/asyncCases.ts`;
const casesVariantDirUrl = `${casesFixturesUrl}/variants/`;

test("loadCasesModule loads cases array", async () => {
  const mod = await loadCasesModule(casesModuleUrl);
  expect(mod.cases).toEqual(["small", "large"]);
  expect(typeof mod.loadCase).toBe("function");
});

test("loadCasesModule throws when cases is missing", async () => {
  const badModuleUrl = `${casesFixturesUrl}/variants/sum.ts`; // has run but no cases
  await expect(loadCasesModule(badModuleUrl)).rejects.toThrow(
    "must export 'cases' array",
  );
});

test("loadCaseData calls loadCase when available", async () => {
  const mod = await loadCasesModule<number[]>(casesModuleUrl);
  const small = await loadCaseData(mod, "small");
  expect(small.data).toEqual([1, 2, 3]);
  expect(small.metadata?.size).toBe(3);

  const large = await loadCaseData(mod, "large");
  expect(large.data).toHaveLength(100);
  expect(large.metadata?.size).toBe(100);
});

test("loadCaseData returns caseId when no loadCase", async () => {
  const result = await loadCaseData(undefined, "myCase");
  expect(result.data).toBe("myCase");
  expect(result.metadata).toBeUndefined();
});

test("loadCaseData handles async loadCase", async () => {
  const mod = await loadCasesModule<string>(asyncCasesUrl);
  const loaded = await loadCaseData(mod, "alpha");
  expect(loaded.data).toBe("ALPHA");
  expect(loaded.metadata?.original).toBe("alpha");
});

test("inline variants with casesModule", async () => {
  const matrix: BenchMatrix<number[]> = {
    name: "InlineCasesModule",
    variants: {
      sum: (arr: number[]) => arr.reduce((a, b) => a + b, 0),
      length: (arr: number[]) => arr.length,
    },
    casesModule: casesModuleUrl,
  };
  const results = await runMatrix(matrix, { iterations: 5 });
  expect(results.variants).toHaveLength(2);
  expect(results.variants[0].cases).toHaveLength(2);
  const cases = results.variants[0].cases;
  expect(cases.map(c => c.caseId)).toEqual(["small", "large"]);
  expect(cases[0].metadata?.size).toBe(3);
  expect(cases[1].metadata?.size).toBe(100);
});

test("inline variants with async casesModule", async () => {
  const matrix: BenchMatrix<string> = {
    name: "AsyncCasesModule",
    variants: {
      lower: (s: string) => s.toLowerCase(),
    },
    casesModule: asyncCasesUrl,
  };
  const results = await runMatrix(matrix, { iterations: 5 });
  expect(results.variants).toHaveLength(1);
  expect(results.variants[0].cases).toHaveLength(2);
  expect(results.variants[0].cases.map(c => c.caseId)).toEqual([
    "alpha",
    "beta",
  ]);
});

test("variantDir with casesModule in worker", async () => {
  const matrix: BenchMatrix<number[]> = {
    name: "WorkerCasesModule",
    variantDir: casesVariantDirUrl,
    casesModule: casesModuleUrl,
  };
  const results = await runMatrix(matrix, { iterations: 5 });
  const variantIds = results.variants.map(v => v.id).sort();
  expect(variantIds).toEqual(["product", "sum"]);
  const sum = results.variants.find(v => v.id === "sum");
  expect(sum?.cases).toHaveLength(2);
  expect(sum?.cases.map(c => c.caseId)).toEqual(["small", "large"]);
});

test("error when both baselineDir and baselineVariant set", async () => {
  const matrix: BenchMatrix = {
    name: "Invalid",
    variantDir: workerFixturesUrl,
    baselineDir: workerFixturesUrl,
    baselineVariant: "fast",
  };
  await expect(runMatrix(matrix)).rejects.toThrow(
    "cannot have both 'baselineDir' and 'baselineVariant'",
  );
});

test("error when inline variants use baselineDir", async () => {
  const matrix: BenchMatrix = {
    name: "Invalid",
    variants: { fast: () => {} },
    baselineDir: workerFixturesUrl,
  };
  await expect(runMatrix(matrix)).rejects.toThrow("cannot use 'baselineDir'");
});

test("baselineVariant with inline variants", async () => {
  const matrix: BenchMatrix = {
    name: "BaselineVariantTest",
    variants: {
      fast: () => {},
      slow: () => {
        let _x = 0;
        for (let i = 0; i < 1000; i++) _x++;
      },
    },
    baselineVariant: "fast",
  };
  const results = await runMatrix(matrix, { iterations: 20 });
  expect(results.variants).toHaveLength(2);

  const fastVariant = results.variants.find(v => v.id === "fast");
  const slowVariant = results.variants.find(v => v.id === "slow");

  expect(fastVariant?.cases[0].baseline).toBeUndefined();
  expect(fastVariant?.cases[0].deltaPercent).toBeUndefined();

  expect(slowVariant?.cases[0].baseline).toBeDefined();
  expect(slowVariant?.cases[0].deltaPercent).toBeDefined();
  expect(typeof slowVariant?.cases[0].deltaPercent).toBe("number");
});

test("baselineVariant error when variant not found", async () => {
  const matrix: BenchMatrix = {
    name: "BadBaselineVariant",
    variants: { fast: () => {} },
    baselineVariant: "nonexistent",
  };
  await expect(runMatrix(matrix)).rejects.toThrow(
    "Baseline variant 'nonexistent' not found",
  );
});

const variantsDirUrl = `file://${import.meta.dirname}/fixtures/variants/`;
const baselineDirUrl = `file://${import.meta.dirname}/fixtures/baseline/`;

test("baselineDir comparison", async () => {
  const matrix: BenchMatrix = {
    name: "BaselineDirTest",
    variantDir: variantsDirUrl,
    baselineDir: baselineDirUrl,
    cases: ["a"],
  };
  const results = await runMatrix(matrix, { iterations: 10 });

  expect(results.variants).toHaveLength(2); // impl and extra
  const implVariant = results.variants.find(v => v.id === "impl");
  expect(implVariant).toBeDefined();
  const caseResult = implVariant!.cases[0];
  expect(caseResult.baseline).toBeDefined();
  expect(caseResult.deltaPercent).toBeDefined();
  expect(typeof caseResult.deltaPercent).toBe("number");
  // Current impl is faster (no work), baseline is slower (loop)
  // So deltaPercent should be negative (current is faster than baseline)
  expect(caseResult.deltaPercent).toBeLessThan(0);
});

test("baselineDir only applies to matching variants", async () => {
  // extra.ts exists in variants/ but not in baseline/
  const matrix: BenchMatrix = {
    name: "PartialBaselineTest",
    variantDir: variantsDirUrl,
    baselineDir: baselineDirUrl,
    cases: ["a"],
  };
  const results = await runMatrix(matrix, { iterations: 10 });

  const variantIds = results.variants.map(v => v.id).sort();
  expect(variantIds).toEqual(["extra", "impl"]);

  // impl should have baseline (matches file in baselineDir)
  const implVariant = results.variants.find(v => v.id === "impl");
  expect(implVariant?.cases[0].baseline).toBeDefined();

  // extra should NOT have baseline (no matching file in baselineDir)
  const extraVariant = results.variants.find(v => v.id === "extra");
  expect(extraVariant?.cases[0].baseline).toBeUndefined();
  expect(extraVariant?.cases[0].deltaPercent).toBeUndefined();
});

test("baselineVariant with variantDir", async () => {
  const matrix: BenchMatrix = {
    name: "BaselineVariantDirTest",
    variantDir: variantsDirUrl,
    baselineVariant: "impl",
    cases: ["a"],
  };
  const results = await runMatrix(matrix, { iterations: 10 });

  const variantIds = results.variants.map(v => v.id).sort();
  expect(variantIds).toEqual(["extra", "impl"]);

  // impl is baseline, should not have baseline/deltaPercent
  const implVariant = results.variants.find(v => v.id === "impl");
  expect(implVariant?.cases[0].baseline).toBeUndefined();

  // extra should have baseline referencing impl
  const extraVariant = results.variants.find(v => v.id === "extra");
  expect(extraVariant?.cases[0].baseline).toBeDefined();
  expect(extraVariant?.cases[0].deltaPercent).toBeDefined();
});

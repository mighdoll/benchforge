#!/usr/bin/env -S node --expose-gc --allow-natives-syntax
import { type MatrixSuite, runBenchCli } from "../../index.ts";

const suite: MatrixSuite = {
  name: "Test",
  matrices: [
    {
      name: "Math",
      variants: {
        plus: () => 1 + 1,
        multiply: () => 2 * 2,
      },
    },
    {
      name: "Array Math",
      caseData: { nums: () => ({ nums: [1, 2, 3, 4, 5] }) },
      variants: {
        "array sum": ({ nums }: any) =>
          nums.reduce((a: number, b: number) => a + b, 0),
      },
    },
  ],
};

await runBenchCli({ build: () => ({ suite }) });

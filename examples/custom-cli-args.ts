#!/usr/bin/env -S node --expose-gc --allow-natives-syntax
import {
  type BenchMatrix,
  type MatrixSuite,
  runBenchCli,
} from "../src/index.ts";

// Example showing how to add custom CLI arguments to benchmarks

const math: BenchMatrix = {
  name: "Math Operations",
  variants: {
    multiply: () => 42 * 1337,
    divide: () => 1337 / 42,
    power: () => 2 ** 16,
  },
};

await runBenchCli({
  configure: y =>
    y.option("size", {
      type: "number",
      default: 100,
      describe: "size of arrays to allocate and reduce",
    }),
  build: args => {
    console.log(`Testing with array size: ${args.size}`);
    const garbage: BenchMatrix<number> = {
      name: "Garbage Generation",
      caseData: { [`size-${args.size}`]: args.size },
      variants: {
        "array-reduce": size => {
          const arrays = [];
          for (let i = 0; i < size; i++) {
            const innerArray: number[] = Array.from({ length: 100 });
            for (let j = 0; j < 100; j++) {
              innerArray[j] = Math.random() * 1000;
            }
            arrays.push(innerArray);
          }
          return arrays
            .map(arr => arr.reduce((sum, val) => sum + val, 0))
            .reduce((total, sum) => total + sum, 0);
        },
      },
    };
    const suite: MatrixSuite = {
      name: "Custom Args Demo",
      matrices: [math, garbage],
    };
    return { suite };
  },
});

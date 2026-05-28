#!/usr/bin/env -S node --expose-gc --allow-natives-syntax
import { type BenchGroup, type BenchSuite, runBenchCli } from "../src/index.ts";

// Example showing how to add custom CLI arguments to benchmarks

const mathGroup: BenchGroup<void> = {
  name: "Math Operations",
  benchmarks: [
    { name: "multiply", fn: () => 42 * 1337 },
    { name: "divide", fn: () => 1337 / 42 },
    { name: "power", fn: () => 2 ** 16 },
  ],
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
    const garbageGroup: BenchGroup<{ size: number }> = {
      name: "Garbage Generation",
      setup: () => ({ size: args.size }),
      benchmarks: [
        {
          name: `array-reduce-${args.size}`,
          fn: ({ size }) => {
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
      ],
    };
    const suite: BenchSuite = {
      name: "Custom Args Demo",
      groups: [mathGroup, garbageGroup],
    };
    return { suite };
  },
});

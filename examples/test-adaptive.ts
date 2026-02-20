#!/usr/bin/env -S node --expose-gc --allow-natives-syntax
import {
  type BenchSuite,
  defaultReport,
  parseBenchArgs,
  runBenchmarks,
} from "../src/index.ts";

const suite: BenchSuite = {
  name: "Adaptive Mode Test",
  groups: [
    {
      name: "Array Operations",
      baseline: {
        name: "array-for-loop",
        fn() {
          const arr = Array.from({ length: 1000 }, (_, i) => i);
          const result = [];
          for (let i = 0; i < arr.length; i++) {
            result.push(arr[i] * 2);
          }
          return result;
        },
      },
      benchmarks: [
        {
          name: "array-map",
          fn() {
            const arr = Array.from({ length: 1000 }, (_, i) => i);
            return arr.map(x => x * 2);
          },
        },
        {
          name: "array-reduce",
          fn() {
            const arr = Array.from({ length: 1000 }, (_, i) => i);
            return arr.reduce((sum, x) => sum + x, 0);
          },
        },
      ],
    },
    {
      name: "String & GC",
      baseline: {
        name: "string-array-join",
        fn() {
          const parts = [];
          for (let i = 0; i < 100; i++) {
            parts.push("hello");
          }
          return parts.join("");
        },
      },
      benchmarks: [
        {
          name: "string-concat",
          fn() {
            let str = "";
            for (let i = 0; i < 100; i++) {
              str += "hello";
            }
            return str;
          },
        },
        {
          name: "gc-heavy",
          fn() {
            // Create garbage to trigger GC
            const arrays = [];
            for (let i = 0; i < 100; i++) {
              arrays.push(Array.from({ length: 1000 }, () => Math.random()));
            }
            return arrays.length;
          },
        },
      ],
    },
  ],
};

const args = parseBenchArgs();
const results = await runBenchmarks(suite, args);
const report = defaultReport(results, args);
console.log(report);

import type { BenchSuite } from "../../index.ts";

const suite: BenchSuite = {
  name: "Suite Export Test",
  groups: [
    {
      name: "Math",
      benchmarks: [
        { name: "plus", fn: () => 1 + 1 },
        { name: "multiply", fn: () => 2 * 2 },
      ],
    },
  ],
};

export default suite;

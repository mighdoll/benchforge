import type { MatrixSuite } from "../../index.ts";

const suite: MatrixSuite = {
  name: "Suite Export Test",
  matrices: [
    {
      name: "Math",
      variants: {
        plus: () => 1 + 1,
        multiply: () => 2 * 2,
      },
    },
  ],
};

export default suite;

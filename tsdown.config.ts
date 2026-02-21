import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "./src/index.ts",
    "./src/bin/benchforge.ts",
    "./src/runners/WorkerScript.ts",
  ],
  format: "esm",
  target: "node22",
  clean: true,
  dts: true,
  sourcemap: true,
  platform: "node",
  external: [
    "esbuild",
    "open",
    "picocolors",
    "playwright",
    "table",
    "yargs",
    "yargs/helpers",
  ],
  logLevel: "warn",
});

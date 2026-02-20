import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/html/browser/index.ts"],
  format: "esm",
  outDir: "dist/browser",
  platform: "browser",
  target: "es2022",
  external: ["d3", "@observablehq/plot"],
  clean: true,
  logLevel: "warn",
});

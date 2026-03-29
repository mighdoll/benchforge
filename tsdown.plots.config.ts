import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    plots: "src/html/browser/index.ts",
    shell: "src/viewer/shell.ts",
  },
  format: "esm",
  outDir: "dist/browser",
  platform: "browser",
  target: "es2022",
  noExternal: [/.*/],
  clean: true,
  logLevel: "warn",
});

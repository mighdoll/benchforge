#!/usr/bin/env node
/** CLI entry point: dispatches to `view` subcommand or default benchmark runner. */
import { hideBin } from "yargs/helpers";

const argv = hideBin(process.argv);

if (argv[0] === "view") {
  const filePath = argv[1];
  if (!filePath) {
    console.error("Usage: benchforge view <file.benchforge>");
    process.exit(1);
  }
  const { viewArchive } = await import("../cli/ViewerServer.ts");
  await viewArchive(filePath);
} else if (argv[0] === "analyze") {
  const filePath = argv[1];
  if (!filePath) {
    console.error("Usage: benchforge analyze <file.benchforge>");
    process.exit(1);
  }
  const { analyzeArchive } = await import("../cli/AnalyzeArchive.ts");
  await analyzeArchive(filePath);
} else {
  const { runDefaultBench } = await import("../index.ts");
  await runDefaultBench();
}

#!/usr/bin/env node
/** CLI entry point: dispatches to `view` subcommand or default benchmark runner. */
import { hideBin } from "yargs/helpers";

const [command, filePath] = hideBin(process.argv);

function requireFile(subcommand: string): string {
  if (filePath) return filePath;
  console.error(`Usage: benchforge ${subcommand} <file.benchforge>`);
  process.exit(1);
}

if (command === "view") {
  const { viewArchive } = await import("../cli/ViewerServer.ts");
  await viewArchive(requireFile("view"));
} else if (command === "analyze") {
  const { analyzeArchive } = await import("../cli/AnalyzeArchive.ts");
  await analyzeArchive(requireFile("analyze"));
} else {
  const { runDefaultBench } = await import("../index.ts");
  await runDefaultBench();
}

#!/usr/bin/env node
import { hideBin } from "yargs/helpers";

const argv = hideBin(process.argv);

if (argv[0] === "view") {
  const filePath = argv[1];
  if (!filePath) {
    console.error("Usage: benchforge view <file.benchforge>");
    process.exit(1);
  }
  const { viewArchive } = await import("../viewer/ViewerServer.ts");
  await viewArchive(filePath);
} else {
  const { runDefaultBench } = await import("../index.ts");
  await runDefaultBench();
}

import type { Argv } from "yargs";
import yargs from "yargs";
import type { DefaultCliArgs } from "./CliArgs.ts";

/** The run/calibration flags a preset may set, picked from the CLI options so
 *  presets stay in sync with the flags and use the same (kebab-case) names. A
 *  suite ships these as named presets; they are applied as yargs defaults
 *  before parsing, so an explicit command-line flag always overrides them. */
export type RunDefaults = Partial<
  Pick<
    DefaultCliArgs,
    | "duration"
    | "iterations"
    | "batches"
    | "warmup-batch"
    | "equiv-margin"
    | "calibrate-runs"
    | "no-batch-trim"
    | "max-samples"
    | "warmup"
  >
>;

/** Seed yargs defaults from a preset. Explicit flags still win at parse time. */
export function applyRunDefaults<T>(y: Argv<T>, defs: RunDefaults): Argv<T> {
  for (const [key, value] of Object.entries(defs)) {
    if (value !== undefined) y.default(key, value);
  }
  return y;
}

/** Read --preset from argv ahead of the main parse, which needs the chosen
 *  preset's values seeded as defaults. Ignores every other flag. */
export function readPreset(argv: string[]): string | undefined {
  const parsed = yargs(argv)
    .option("preset", { type: "string" })
    .help(false)
    .version(false)
    .parseSync();
  return parsed.preset;
}

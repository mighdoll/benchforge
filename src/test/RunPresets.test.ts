import { expect, test } from "vitest";
import { defaultCliArgs, parseCliArgs } from "../cli/CliArgs.ts";
import { applyRunDefaults, readPreset } from "../cli/RunPresets.ts";

const presets = {
  quick: {
    batches: 100,
    duration: 0.1,
    "equiv-margin": 0.5,
    "calibrate-runs": 10,
  },
  thorough: { batches: 200, duration: 0.5, "equiv-margin": 0.3 },
};

/** Resolve args the way runBenchCli does: register --preset, then seed the
 *  chosen preset as defaults. */
function parse(argv: string[]) {
  const name = readPreset(argv) ?? "quick";
  const chosen = presets[name as keyof typeof presets] ?? {};
  return parseCliArgs(y => {
    const withPreset = defaultCliArgs(y).option("preset", {
      type: "string",
      choices: Object.keys(presets),
      default: "quick",
    });
    return applyRunDefaults(withPreset, chosen);
  }, argv);
}

test("preset values apply when only --preset is given", () => {
  const args = parse(["--preset", "thorough"]);
  expect(args.batches).toBe(200);
  expect(args.duration).toBe(0.5);
  expect(args["equiv-margin"]).toBe(0.3);
});

test("explicit flag overrides the preset", () => {
  const args = parse(["--preset", "quick", "--equiv-margin", "0.8"]);
  expect(args.batches).toBe(100); // from preset
  expect(args["equiv-margin"]).toBe(0.8); // from the flag
});

test("default preset applies when --preset is omitted", () => {
  const args = parse([]);
  expect(args.batches).toBe(100);
  expect(args.duration).toBe(0.1);
  expect(args["calibrate-runs"]).toBe(10);
});

test("readPreset extracts the name and ignores other flags", () => {
  expect(
    readPreset(["bench.ts", "--batches", "7", "--preset", "thorough"]),
  ).toBe("thorough");
  expect(readPreset(["--batches", "7"])).toBeUndefined();
});

test("built-in defaults stand when a preset omits a field", () => {
  // thorough sets no calibrate-runs, so the CLI default (15) remains.
  const args = parse(["--preset", "thorough"]);
  expect(args["calibrate-runs"]).toBe(15);
});

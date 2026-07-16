import { expect, test } from "vitest";
import { formatCliCommand } from "../report/CliCommand.ts";

test("falls back to bare benchforge with no args", () => {
  expect(formatCliCommand()).toBe("benchforge");
  expect(formatCliCommand({})).toBe("benchforge");
});

test("renders boolean flags bare and valued flags with their value", () => {
  const cmd = formatCliCommand({ profile: true, batches: 4 });
  expect(cmd).toBe("benchforge --profile --batches 4");
});

test("drops internal keys, false flags, and args matching defaults", () => {
  const args = {
    _: ["x"],
    $0: "bench",
    view: true,
    file: "a.ts",
    gc: false,
    batches: 1,
  };
  const cmd = formatCliCommand(args, { batches: 1 });
  expect(cmd).toBe("benchforge");
});

test("skips camelCase aliases yargs duplicates from kebab-case flags", () => {
  const cmd = formatCliCommand({ "equiv-margin": 2, equivMargin: 2 });
  expect(cmd).toBe("benchforge --equiv-margin 2");
});

test("hides calibrate-only flags outside calibrate mode", () => {
  const cmd = formatCliCommand({ batches: 4, "calibrate-runs": 10 });
  expect(cmd).toBe("benchforge --batches 4");
});

test("shows calibrate-only flags when calibrating", () => {
  const cmd = formatCliCommand({ calibrate: true, "calibrate-runs": 10 });
  expect(cmd).toBe("benchforge --calibrate --calibrate-runs 10");
});

test("drops kebab-case alias twins yargs duplicates from canonical flags", () => {
  const args = {
    profile: true,
    "time-sample": true,
    "profile-interval": 200,
    "time-interval": 200,
  };
  const cmd = formatCliCommand(args);
  expect(cmd).toBe("benchforge --profile --profile-interval 200");
});

test("hides user-only filters at their default-on value", () => {
  const args = {
    profile: true,
    "profile-user-only": true,
    alloc: true,
    "alloc-user-only": true,
  };
  const defaults = { "profile-user-only": true, "alloc-user-only": true };
  expect(formatCliCommand(args, defaults)).toBe("benchforge --profile --alloc");
});

test("echoes --no user-only only when its parent mode runs", () => {
  const defaults = { "profile-user-only": true, "alloc-user-only": true };
  const withProfile = formatCliCommand(
    { profile: true, "profile-user-only": false },
    defaults,
  );
  expect(withProfile).toBe("benchforge --profile --no-profile-user-only");
  const withoutProfile = formatCliCommand(
    { "profile-user-only": false },
    defaults,
  );
  expect(withoutProfile).toBe("benchforge");
});

const skipArgs = new Set(["_", "$0", "view", "file"]);

/** Flags that only affect a --calibrate run; inert (and confusing) to echo for
 *  a normal comparison, where a preset may still have set them to a non-default. */
const calibrateOnlyArgs = new Set(["calibrate-runs"]);

/** Reconstruct the benchforge invocation from parsed yargs args, dropping
 *  internal keys, defaults, false flags, camelCase aliases, and flags that do
 *  not apply to the current run mode. Falls back to "benchforge" when there are
 *  no displayable flags. */
export function formatCliCommand(
  args?: Record<string, unknown>,
  defaults?: Record<string, unknown>,
): string {
  if (!args) return "benchforge";
  const calibrating = args.calibrate === true;
  const isDisplayable = (key: string, value: unknown): boolean => {
    if (skipArgs.has(key) || value === undefined || value === false)
      return false;
    if (!calibrating && calibrateOnlyArgs.has(key)) return false;
    if (defaults?.[key] === value) return false;
    // skip camelCase aliases (yargs generates both kebab-case and camelCase)
    if (!key.includes("-") && key !== key.toLowerCase()) return false;
    return true;
  };
  const flags = Object.entries(args)
    .filter(([key, value]) => isDisplayable(key, value))
    .map(([key, value]) => (value === true ? `--${key}` : `--${key} ${value}`));
  return ["benchforge", ...flags].join(" ");
}

const skipArgs = new Set(["_", "$0", "view", "file"]);

/** Flags that only affect a --calibrate run; inert (and confusing) to echo for
 *  a normal comparison, where a preset may still have set them to a non-default. */
const calibrateOnlyArgs = new Set(["calibrate-runs"]);

/** Kebab-case alias keys yargs duplicates onto their canonical flag (mirrors the
 *  `alias:` fields in CliArgs). Echoing both halves would double every aliased
 *  flag, e.g. --profile plus its --time-sample twin. */
const aliasArgs = new Set([
  "time-sample",
  "time-interval",
  "html",
  "export-time",
]);

/** User-code filter flags default on; they only matter when their parent
 *  profiling mode actually samples, so echo them (as --no-... when overridden)
 *  only then. These predicates mirror needsProfile / needsAlloc in CliOptions;
 *  kept inline so CliCommand stays a leaf the browser viewer imports without
 *  pulling in the CLI-parsing (yargs) dependency chain. */
const userOnlyGates: Record<string, (a: Record<string, unknown>) => boolean> = {
  "profile-user-only": a => a.profile === true || !!a["export-profile"],
  "alloc-user-only": a =>
    a.alloc === true || a.archive != null || a["alloc-raw"] === true,
};

/** Reconstruct the benchforge invocation from parsed yargs args, dropping
 *  internal keys, defaults, false flags, alias twins (camelCase and kebab), and
 *  flags that do not apply to the current run mode. Falls back to "benchforge"
 *  when there are no displayable flags. */
export function formatCliCommand(
  args?: Record<string, unknown>,
  defaults?: Record<string, unknown>,
): string {
  if (!args) return "benchforge";
  const calibrating = args.calibrate === true;
  const isDisplayable = (key: string, value: unknown): boolean => {
    if (skipArgs.has(key) || aliasArgs.has(key) || value === undefined)
      return false;
    // skip camelCase aliases (yargs generates both kebab-case and camelCase)
    if (!key.includes("-") && key !== key.toLowerCase()) return false;
    if (!calibrating && calibrateOnlyArgs.has(key)) return false;
    const gate = userOnlyGates[key];
    if (gate) return gate(args) && defaults?.[key] !== value;
    if (value === false || defaults?.[key] === value) return false;
    return true;
  };
  const flags = Object.entries(args)
    .filter(([key, value]) => isDisplayable(key, value))
    .map(([key, value]) => renderFlag(key, value));
  return ["benchforge", ...flags].join(" ");
}

/** Render one flag: bare for true, --no-... for false, key + value otherwise. */
function renderFlag(key: string, value: unknown): string {
  if (value === true) return `--${key}`;
  if (value === false) return `--no-${key}`;
  return `--${key} ${value}`;
}

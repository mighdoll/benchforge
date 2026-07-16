import { formatRelativeTime } from "./DateFormat.ts";

declare const __BENCHFORGE_GIT_HASH__: string;
declare const __BENCHFORGE_GIT_DIRTY__: boolean;
declare const __BENCHFORGE_BUILD_DATE__: string;

/** Assemble "benchforge <hash> <relative-date>" from compile-time globals.
 *  The `typeof` guards read the globals safely when they are absent (dev/unbundled
 *  builds): `typeof` never throws on an undeclared identifier, and Vite/esbuild
 *  `define` substitutes the literal inside `typeof` too, so bundled builds fold to
 *  the real values. A guard on a bound argument couldn't do this: evaluating the
 *  bare global to pass it would throw first. */
export function benchforgeLabel(): string {
  const hash =
    typeof __BENCHFORGE_GIT_HASH__ !== "undefined"
      ? __BENCHFORGE_GIT_HASH__
      : "dev";
  const dirty =
    typeof __BENCHFORGE_GIT_DIRTY__ !== "undefined" && __BENCHFORGE_GIT_DIRTY__;
  const date =
    typeof __BENCHFORGE_BUILD_DATE__ !== "undefined"
      ? __BENCHFORGE_BUILD_DATE__
      : "";
  const label = `benchforge ${hash}${dirty ? "*" : ""}`;
  return date ? `${label} ${formatRelativeTime(date)}` : label;
}

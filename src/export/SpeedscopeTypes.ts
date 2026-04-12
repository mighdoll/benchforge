/** Shared speedscope file format types and frame interning utilities. */

/** speedscope file format (https://www.speedscope.app/file-format-schema.json) */
export interface SpeedscopeFile {
  $schema: "https://www.speedscope.app/file-format-schema.json";
  shared: { frames: SpeedscopeFrame[] };
  profiles: SpeedscopeProfile[];
  name?: string;
  exporter?: string;
}

/** A single call frame with optional source location */
export interface SpeedscopeFrame {
  name: string;
  file?: string;
  line?: number;
  col?: number;
}

/** Union of heap and time profile shapes (unit differs) */
export type SpeedscopeProfile = SpeedscopeHeapProfile | SpeedscopeTimeProfile;

/** Heap allocation profile weighted by bytes */
export interface SpeedscopeHeapProfile {
  type: "sampled";
  name: string;
  unit: "bytes";
  startValue: number;
  endValue: number;
  samples: number[][];
  weights: number[];
}

/** CPU time profile weighted by microseconds */
export interface SpeedscopeTimeProfile {
  type: "sampled";
  name: string;
  unit: "microseconds";
  startValue: number;
  endValue: number;
  samples: number[][];
  weights: number[];
}

/** Shared mutable state for frame interning across profiles. */
export interface FrameContext {
  frames: SpeedscopeFrame[];
  index: Map<string, number>;
}

/** Create an empty FrameContext for building speedscope profiles. */
export function frameContext(): FrameContext {
  return { frames: [], index: new Map() };
}

/** Wrap profiles in a SpeedscopeFile envelope */
export function speedscopeFile(
  ctx: FrameContext,
  profiles: SpeedscopeProfile[],
): SpeedscopeFile {
  return {
    $schema: "https://www.speedscope.app/file-format-schema.json",
    shared: { frames: ctx.frames },
    profiles,
    exporter: "benchforge",
  };
}

/** Intern a call frame, returning its index in the shared frames array.
 *  All values should be 1-indexed (caller converts from V8's 0-indexed if needed). */
export function internFrame(
  name: string,
  url: string,
  line: number,
  col: number | undefined | null,
  ctx: FrameContext,
): number {
  const key = `${name}\0${url}\0${line}\0${col}`;

  const existing = ctx.index.get(key);
  if (existing !== undefined) return existing;

  const idx = ctx.frames.length;
  const entry: SpeedscopeFrame = { name: displayName(name, url, line) };
  if (url) entry.file = url;
  if (line > 0) entry.line = line;
  if (col != null) entry.col = col;
  ctx.frames.push(entry);
  ctx.index.set(key, idx);
  return idx;
}

/** Display name for a frame: named functions use their name, anonymous get a location hint */
function displayName(name: string, url: string, line: number): string {
  if (name !== "(anonymous)") return name;
  const file = url?.split("/").pop();
  return file ? `(anonymous ${file}:${line})` : "(anonymous)";
}

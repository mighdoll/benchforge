/** Shared speedscope file format types and frame interning utilities.
 *  Used by both AllocExport (heap profiles) and TimeExport (CPU profiles). */

/** speedscope file format (https://www.speedscope.app/file-format-schema.json) */
export interface SpeedscopeFile {
  $schema: "https://www.speedscope.app/file-format-schema.json";
  shared: { frames: SpeedscopeFrame[] };
  profiles: SpeedscopeProfile[];
  name?: string;
  exporter?: string;
}

export interface SpeedscopeFrame {
  name: string;
  file?: string;
  line?: number;
  col?: number;
}

/** Union of heap and time profile shapes (unit differs) */
export type SpeedscopeProfile = SpeedscopeHeapProfile | SpeedscopeTimeProfile;

export interface SpeedscopeHeapProfile {
  type: "sampled";
  name: string;
  unit: "bytes";
  startValue: number;
  endValue: number;
  samples: number[][];
  weights: number[];
}

export interface SpeedscopeTimeProfile {
  type: "sampled";
  name: string;
  unit: "microseconds";
  startValue: number;
  endValue: number;
  samples: number[][];
  weights: number[];
}

/** Wrap profiles in a SpeedscopeFile envelope */
export function speedscopeFile(
  frames: SpeedscopeFrame[],
  profiles: SpeedscopeProfile[],
): SpeedscopeFile {
  return {
    $schema: "https://www.speedscope.app/file-format-schema.json",
    shared: { frames },
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
  sharedFrames: SpeedscopeFrame[],
  frameIndex: Map<string, number>,
): number {
  const key = `${name}\0${url}\0${line}\0${col}`;

  const existing = frameIndex.get(key);
  if (existing !== undefined) return existing;

  const idx = sharedFrames.length;
  const entry: SpeedscopeFrame = { name: displayName(name, url, line) };
  if (url) entry.file = url;
  if (line > 0) entry.line = line;
  if (col != null) entry.col = col;
  sharedFrames.push(entry);
  frameIndex.set(key, idx);
  return idx;
}

/** Display name for a frame: named functions use their name, anonymous get a location hint */
function displayName(name: string, url: string, line: number): string {
  if (name !== "(anonymous)") return name;
  const file = url?.split("/").pop();
  return file ? `(anonymous ${file}:${line})` : "(anonymous)";
}

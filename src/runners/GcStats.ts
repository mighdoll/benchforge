/**
 * Aggregated GC statistics from V8 trace events.
 * Node (--trace-gc-nvp) provides all fields; browser (CDP) provides counts, collected, and pause only.
 */
export interface GcStats {
  scavenges: number;
  markCompacts: number;
  totalCollected: number; // bytes freed
  gcPauseTime: number; // total pause time (ms)
  totalAllocated?: number; // bytes allocated (Node only)
  totalPromoted?: number; // bytes promoted to old gen (Node only)
  totalSurvived?: number; // bytes survived in young gen (Node only)
}

/** Single GC event. Node provides all fields; browser provides type, pauseMs, collected. */
export interface GcEvent {
  type: "scavenge" | "mark-compact" | "minor-ms" | "unknown";
  pauseMs: number;
  collected: number;
  allocated?: number; // Node only
  promoted?: number; // Node only
  survived?: number; // Node only
}

/** Parse a single --trace-gc-nvp stderr line into a GcEvent. */
export function parseGcLine(line: string): GcEvent | undefined {
  if (!line.includes("pause=")) return undefined;

  const fields = parseNvpFields(line);
  if (!fields.gc) return undefined;

  const int = (k: string) => Number.parseInt(fields[k] || "0", 10);
  const type = parseGcType(fields.gc);
  const pauseMs = Number.parseFloat(fields.pause || "0");
  if (Number.isNaN(pauseMs)) return undefined;

  const allocated = int("allocated");
  const promoted = int("promoted");
  // V8 uses "new_space_survived" not "survived"
  const survived = int("new_space_survived") || int("survived");
  const start = int("start_object_size");
  const end = int("end_object_size");
  const collected = start > end ? start - end : 0;

  return { type, pauseMs, allocated, collected, promoted, survived };
}

/** Aggregate a list of GC events into summary statistics. */
export function aggregateGcStats(events: GcEvent[]): GcStats {
  let scavenges = 0;
  let markCompacts = 0;
  let gcPauseTime = 0;
  let totalCollected = 0;
  let hasNode = false;
  let totalAllocated = 0;
  let totalPromoted = 0;
  let totalSurvived = 0;

  for (const e of events) {
    if (e.type === "scavenge" || e.type === "minor-ms") scavenges++;
    else if (e.type === "mark-compact") markCompacts++;
    gcPauseTime += e.pauseMs;
    totalCollected += e.collected;
    if (e.allocated != null) {
      hasNode = true;
      totalAllocated += e.allocated;
      totalPromoted += e.promoted ?? 0;
      totalSurvived += e.survived ?? 0;
    }
  }

  return {
    scavenges,
    markCompacts,
    totalCollected,
    gcPauseTime,
    ...(hasNode && { totalAllocated, totalPromoted, totalSurvived }),
  };
}

/** Create a GcStats with all counters zeroed. */
export function emptyGcStats(): GcStats {
  return { scavenges: 0, markCompacts: 0, totalCollected: 0, gcPauseTime: 0 };
}

/** Parse name=value pairs from a trace-gc-nvp line. */
function parseNvpFields(line: string): Record<string, string> {
  const pairs = [...line.matchAll(/(\w+)=([^\s,]+)/g)];
  return Object.fromEntries(pairs.map(([, k, v]) => [k, v]));
}

/** Map V8 gc type codes to normalized event types. */
function parseGcType(gcField: string): GcEvent["type"] {
  // V8 uses: s=scavenge, mc=mark-compact, mmc=minor-mc (young gen mark-compact)
  if (gcField === "s" || gcField === "scavenge") return "scavenge";
  if (gcField === "mc" || gcField === "ms" || gcField === "mark-compact")
    return "mark-compact";
  if (gcField === "mmc" || gcField === "minor-mc" || gcField === "minor-ms")
    return "minor-ms";
  return "unknown";
}

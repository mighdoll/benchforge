/** GC statistics aggregated from V8 trace events.
 *  Node (--trace-gc-nvp) provides all fields.
 *  Browser (CDP Tracing) provides counts, collected, and pause only. */
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

/** Parse a single --trace-gc-nvp stderr line */
export function parseGcLine(line: string): GcEvent | undefined {
  // V8 format: [pid:addr:gen] N ms: pause=X gc=s ... allocated=N promoted=N ...
  if (!line.includes("pause=")) return undefined;

  const fields = parseNvpFields(line);
  if (!fields.gc) return undefined;

  const int = (k: string) => Number.parseInt(fields[k] || "0", 10);
  const type = parseGcType(fields.gc);
  const pauseMs = Number.parseFloat(fields.pause || "0");
  const allocated = int("allocated");
  const promoted = int("promoted");
  // V8 uses "new_space_survived" not "survived"
  const survived = int("new_space_survived") || int("survived");
  // Calculate collected from start/end object size if available
  const startSize = int("start_object_size");
  const endSize = int("end_object_size");
  const collected = startSize > endSize ? startSize - endSize : 0;

  if (Number.isNaN(pauseMs)) return undefined;

  return { type, pauseMs, allocated, collected, promoted, survived };
}

/** Parse name=value pairs from trace-gc-nvp line */
function parseNvpFields(line: string): Record<string, string> {
  const fields: Record<string, string> = {};
  // Format: "key=value, key=value, ..." or "key=value key=value"
  const matches = line.matchAll(/(\w+)=([^\s,]+)/g);
  for (const [, key, value] of matches) {
    fields[key] = value;
  }
  return fields;
}

/** Map V8 gc type codes to our types */
function parseGcType(gcField: string): GcEvent["type"] {
  // V8 uses: s=scavenge, mc=mark-compact, mmc=minor-mc (young gen mark-compact)
  if (gcField === "s" || gcField === "scavenge") return "scavenge";
  if (gcField === "mc" || gcField === "ms" || gcField === "mark-compact")
    return "mark-compact";
  if (gcField === "mmc" || gcField === "minor-mc" || gcField === "minor-ms")
    return "minor-ms";
  return "unknown";
}

/** Aggregate GC events into summary stats */
export function aggregateGcStats(events: GcEvent[]): GcStats {
  let scavenges = 0;
  let markCompacts = 0;
  let gcPauseTime = 0;
  let totalCollected = 0;
  let hasNodeFields = false;
  let totalAllocated = 0;
  let totalPromoted = 0;
  let totalSurvived = 0;

  for (const e of events) {
    if (e.type === "scavenge" || e.type === "minor-ms") scavenges++;
    else if (e.type === "mark-compact") markCompacts++;
    gcPauseTime += e.pauseMs;
    totalCollected += e.collected;
    if (e.allocated != null) {
      hasNodeFields = true;
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
    ...(hasNodeFields && { totalAllocated, totalPromoted, totalSurvived }),
  };
}

/** @return GcStats with all counters zeroed */
export function emptyGcStats(): GcStats {
  return { scavenges: 0, markCompacts: 0, totalCollected: 0, gcPauseTime: 0 };
}

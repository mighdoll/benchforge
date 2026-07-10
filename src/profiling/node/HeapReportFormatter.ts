import { frameLocation } from "../../report/Formatters.ts";
import type { ResolvedProfile } from "./ResolvedProfile.ts";

/** Format every raw sample as one line, ordered by ordinal (time).
 *  Output is tab-separated for easy piping/grep/diff. */
export function formatRawSamples(resolved: ResolvedProfile): string {
  const { sortedSamples, nodeMap } = resolved;
  if (!sortedSamples || sortedSamples.length === 0)
    return "No raw samples available.";

  const header = "ordinal\tsize\tfunction\tlocation";
  const rows = sortedSamples.map(s => {
    const frame = nodeMap.get(s.nodeId)?.frame;
    const fn = frame?.name || "(unknown)";
    const url = frame?.url || "";
    const loc = url ? frameLocation(url, frame!.line, frame!.col) : "(unknown)";
    return `${s.ordinal}\t${s.size}\t${fn}\t${loc}`;
  });
  return [header, ...rows].join("\n");
}

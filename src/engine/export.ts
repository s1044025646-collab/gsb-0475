import type { SimulationResult } from "./types.ts";

export function resultToJSON(result: SimulationResult): string {
  return JSON.stringify(result, null, 2);
}

function cell(v: unknown): string {
  const s = v === null ? "NA" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function segmentsToCSV(result: SimulationResult): string {
  const header = [
    "index", "id", "start", "end", "duration", "current", "m", "mode",
    "fullOperateTime", "zBefore", "zAfter", "processedDuration",
    "unprocessedSuffix", "zeroResetAt"
  ];
  const lines = [header.join(",")];
  for (const s of result.segments) {
    lines.push([
      s.index, s.id, s.start, s.end, s.duration, s.current, s.m, s.mode,
      s.fullOperateTime, s.zBefore, s.zAfter, s.processedDuration,
      s.unprocessedSuffix, s.zeroResetAt
    ].map(cell).join(","));
  }
  if (result.trip) {
    lines.push("");
    lines.push(`# tripped,${result.trip.segmentId},tripTime,${result.trip.tripTime},offset,${result.trip.offsetInSegment}`);
  }
  return lines.join("\n");
}

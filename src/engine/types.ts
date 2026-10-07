export const ALGO_VERSION = "IEC-NI-0.14/v1";
export const TOLERANCE_VERSION = "abs1e-12-rel1e-12/v1";

export interface Config {
  ip: number;
  tms: number;
  tr: number;
}

export type SegmentMode = "OPERATE" | "RESET";

export interface RawSegment {
  id: string;
  duration: number;
  current: number;
}

export interface ProcessedSegment {
  id: string;
  index: number;
  start: number;
  end: number;
  duration: number;
  current: number;
  m: number;
  mode: SegmentMode;
  fullOperateTime: number | null;
  zBefore: number;
  zAfter: number;
  processedDuration: number;
  unprocessedSuffix: number;
  zeroResetAt: number | null;
}

export interface TripInfo {
  segmentId: string;
  segmentIndex: number;
  segmentStart: number;
  offsetInSegment: number;
  tripTime: number;
  zBefore: number;
}

export interface SimulationResult {
  algoVersion: string;
  toleranceVersion: string;
  config: Config;
  segments: ProcessedSegment[];
  tripped: boolean;
  trip: TripInfo | null;
  finalZ: number;
  totalDuration: number;
  processedDuration: number;
  unprocessedDuration: number;
}

export interface StateAtTime {
  time: number;
  segmentId: string | null;
  segmentIndex: number | null;
  offsetInSegment: number | null;
  mode: SegmentMode | "LATCHED" | "BEFORE_START";
  m: number | null;
  z: number;
  tripped: boolean;
  fullOperateTime: number | null;
}

export class SimError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "SimError";
    this.code = code;
    this.details = details;
  }
}

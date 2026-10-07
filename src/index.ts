export { simulate, stateAtTime, compareRuns } from "./engine/simulate.ts";
export type { RunComparison } from "./engine/simulate.ts";
export { operateTime, operateRate } from "./engine/curve.ts";
export { validateConfig, validateSegments, LIMITS } from "./engine/validate.ts";
export { segmentsToCSV, resultToJSON } from "./engine/export.ts";
export { Store, parseResult } from "./db/store.ts";
export type { RunRecord } from "./db/store.ts";
export { ALGO_VERSION, TOLERANCE_VERSION, SimError } from "./engine/types.ts";
export type {
  Config, RawSegment, ProcessedSegment, SimulationResult, StateAtTime, TripInfo
} from "./engine/types.ts";

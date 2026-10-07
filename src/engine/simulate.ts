import { operateTime } from "./curve.ts";
import { validateConfig, validateSegments } from "./validate.ts";
import {
  ALGO_VERSION,
  TOLERANCE_VERSION,
  SimError,
  type Config,
  type ProcessedSegment,
  type RawSegment,
  type SimulationResult,
  type StateAtTime
} from "./types.ts";

const EPS = 1e-12;

export function simulate(rawConfig: unknown, rawSegments: unknown): SimulationResult {
  const config = validateConfig(rawConfig);
  const segments = validateSegments(rawSegments);

  let z = 0;
  let tCursor = 0;
  const processed: ProcessedSegment[] = [];
  let trip: SimulationResult["trip"] = null;
  let processedDuration = 0;

  for (let index = 0; index < segments.length; index++) {
    const seg = segments[index]!;
    const start = tCursor;
    const end = start + seg.duration;
    const m = seg.current / config.ip;
    const zBefore = z;

    if (trip) {
      processed.push({
        id: seg.id, index, start, end, duration: seg.duration, current: seg.current, m,
        mode: m > 1 ? "OPERATE" : "RESET",
        fullOperateTime: null,
        zBefore: 1, zAfter: 1,
        processedDuration: 0,
        unprocessedSuffix: seg.duration,
        zeroResetAt: null
      });
      tCursor = end;
      continue;
    }

    if (m > 1) {
      const tFull = operateTime(m, config.tms);
      const need = (1 - zBefore) * tFull;
      if (!Number.isFinite(need) || need < 0) {
        throw new SimError("NUMERIC_NONFINITE", "剩余需求时间计算无效", { segId: seg.id, need });
      }
      if (need <= seg.duration + EPS) {
        const offset = Math.min(need, seg.duration);
        trip = {
          segmentId: seg.id, segmentIndex: index, segmentStart: start,
          offsetInSegment: offset, tripTime: start + offset, zBefore
        };
        z = 1;
        processed.push({
          id: seg.id, index, start, end, duration: seg.duration, current: seg.current, m,
          mode: "OPERATE", fullOperateTime: tFull,
          zBefore, zAfter: 1,
          processedDuration: offset,
          unprocessedSuffix: seg.duration - offset,
          zeroResetAt: null
        });
        processedDuration += offset;
      } else {
        const dz = seg.duration / tFull;
        z = zBefore + dz;
        processed.push({
          id: seg.id, index, start, end, duration: seg.duration, current: seg.current, m,
          mode: "OPERATE", fullOperateTime: tFull,
          zBefore, zAfter: z,
          processedDuration: seg.duration,
          unprocessedSuffix: 0,
          zeroResetAt: null
        });
        processedDuration += seg.duration;
      }
    } else {
      // M <= 1（含等于起动电流）：线性复归 dz/dt = -1/Tr，最低为零
      const timeToZero = zBefore * config.tr;
      let zeroResetAt: number | null = null;
      if (zBefore > 0 && timeToZero <= seg.duration + EPS) {
        zeroResetAt = start + Math.min(timeToZero, seg.duration);
        z = 0;
      } else if (zBefore > 0) {
        z = zBefore - seg.duration / config.tr;
      } else {
        z = 0;
      }
      processed.push({
        id: seg.id, index, start, end, duration: seg.duration, current: seg.current, m,
        mode: "RESET", fullOperateTime: null,
        zBefore, zAfter: z,
        processedDuration: seg.duration,
        unprocessedSuffix: 0,
        zeroResetAt
      });
      processedDuration += seg.duration;
    }
    tCursor = end;
  }

  const totalDuration = segments.reduce((s, x) => s + x.duration, 0);
  return {
    algoVersion: ALGO_VERSION,
    toleranceVersion: TOLERANCE_VERSION,
    config,
    segments: processed,
    tripped: trip !== null,
    trip,
    finalZ: trip ? 1 : z,
    totalDuration,
    processedDuration,
    unprocessedDuration: totalDuration - processedDuration
  };
}

/**
 * 只读段内状态查询：用与正式仿真完全相同的分段线性公式在任意时刻取值，
 * 不修改、也不重新冻结正式结果。跳闸后返回锁存 z=1。
 */
export function stateAtTime(result: SimulationResult, time: number): StateAtTime {
  if (!Number.isFinite(time) || time < 0) {
    throw new SimError("QUERY_TIME_INVALID", "查询时刻必须为非负有限数字", { time });
  }
  if (result.tripped && time >= result.trip!.tripTime) {
    return {
      time, segmentId: result.trip!.segmentId, segmentIndex: result.trip!.segmentIndex,
      offsetInSegment: null, mode: "LATCHED", m: null, z: 1, tripped: true,
      fullOperateTime: null
    };
  }
  if (result.segments.length === 0 || time < (result.segments[0]?.start ?? 0)) {
    return {
      time, segmentId: null, segmentIndex: null, offsetInSegment: null,
      mode: "BEFORE_START", m: null, z: 0, tripped: false, fullOperateTime: null
    };
  }

  let seg = result.segments[result.segments.length - 1]!;
  for (const candidate of result.segments) {
    if (time >= candidate.start && time <= candidate.end + EPS) {
      seg = candidate;
      break;
    }
  }
  // 查询时刻超过输入总时长：钳到最后一段
  const offset = Math.max(0, Math.min(time - seg.start, seg.duration));
  let z: number;
  if (seg.mode === "OPERATE") {
    z = seg.zBefore + offset / seg.fullOperateTime!;
  } else {
    z = Math.max(0, seg.zBefore - offset / result.config.tr);
  }
  if (z > 1 - EPS && seg.mode === "OPERATE") z = Math.min(z, 1);
  return {
    time, segmentId: seg.id, segmentIndex: seg.index, offsetInSegment: offset,
    mode: seg.mode, m: seg.m, z, tripped: false,
    fullOperateTime: seg.fullOperateTime
  };
}

export interface RunComparison {
  trippedA: boolean;
  trippedB: boolean;
  tripTimeA: number | null;
  tripTimeB: number | null;
  tripTimeDelta: number | null;
  earlierTripRun: "A" | "B" | null;
  finalZA: number;
  finalZB: number;
  maxAbsZDiff: number;
  note: string;
}

export function compareRuns(a: SimulationResult, b: SimulationResult): RunComparison {
  const end = Math.max(a.totalDuration, b.totalDuration);
  const samples = Math.max(a.segments.length, b.segments.length) * 4 + 1;
  let maxDiff = 0;
  for (let i = 0; i <= samples; i++) {
    const t = (end * i) / samples;
    const za = stateAtTime(a, t).z;
    const zb = stateAtTime(b, t).z;
    maxDiff = Math.max(maxDiff, Math.abs(za - zb));
  }
  const ta = a.trip?.tripTime ?? null;
  const tb = b.trip?.tripTime ?? null;
  let earlier: "A" | "B" | null = null;
  if (ta !== null && tb !== null) earlier = ta <= tb ? "A" : "B";
  else if (ta !== null) earlier = "A";
  else if (tb !== null) earlier = "B";
  return {
    trippedA: a.tripped,
    trippedB: b.tripped,
    tripTimeA: ta,
    tripTimeB: tb,
    tripTimeDelta: ta !== null && tb !== null ? tb - ta : null,
    earlierTripRun: earlier,
    finalZA: a.finalZ,
    finalZB: b.finalZ,
    maxAbsZDiff: maxDiff,
    note: "maxAbsZDiff 在公共时间轴上按分段线性冻结公式采样比较"
  };
}

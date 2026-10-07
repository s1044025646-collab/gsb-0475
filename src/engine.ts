/**
 * 核心仿真引擎：标准反时限过流动作积分 + 线性复归 + 段内跳闸判定。
 * 纯函数，无副作用；公式与常量集中在此，API 查询与正式仿真共用同一实现。
 */

export const ALGO_VERSION = "iec-standard-inverse-v1";
/** 段末判定的相对容差（用于吸收浮点舍入，不改变物理语义） */
export const TOLERANCE = 1e-12;

export interface RelayConfig {
  /** 起动电流 Ip，正有限，与电流同单位 */
  pickupCurrent: number;
  /** 时间倍率 TMS，正有限 */
  tms: number;
  /** 复归时间 Tr（秒），正有限 */
  resetTime: number;
}

export interface SegmentInput {
  id: string;
  /** 持续时间（秒），正有限 */
  duration: number;
  /** RMS 电流，非负有限，与 Ip 同单位 */
  current: number;
}

export type SegmentMode = "operate" | "reset" | "latched";

export interface TripInfo {
  segmentId: string;
  /** 段内偏移（秒），从段起点算起 */
  offsetInSegment: number;
  /** 绝对跳闸时刻（秒），从 0 累计 */
  tripTime: number;
  /** 触发段动作前进度 z0 */
  progressBefore: number;
  /** 触发后本段未处理的后缀时长（秒） */
  unprocessedSuffix: number;
}

export interface SegmentResult {
  segmentId: string;
  seq: number;
  start: number;
  end: number;
  current: number;
  multiple: number;
  mode: SegmentMode;
  /** 完整动作时间 T(M)；M<=1 或锁存段为 null */
  operatingTime: number | null;
  progressBefore: number;
  progressAfter: number;
  /** 实际参与积分的时长（跳闸段为尚需时间，锁存段为 0） */
  processedDuration: number;
  /** 复归段：段内进度降到 0 的绝对时刻；未降到 0 或非复归段为 null */
  resetToZeroAt: number | null;
}

export interface SimulationResult {
  algoVersion: string;
  tolerance: number;
  config: RelayConfig;
  segments: SegmentResult[];
  trip: TripInfo | null;
  /** 仿真覆盖的总时长 */
  totalDuration: number;
}

/** 参数幅值上限，防止无意义巨型输入 */
export const LIMITS = {
  maxParam: 1e9,
  maxCurrent: 1e12,
  maxDuration: 1e9,
  maxSegments: 100000,
  maxIdLength: 128,
} as const;

export class ValidationError extends Error {
  readonly code = "VALIDATION_ERROR";
  readonly details: string[];
  constructor(details: string[]) {
    super(details.join("; "));
    this.details = details;
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function validateConfig(raw: unknown): RelayConfig {
  const errs: string[] = [];
  const o = (raw ?? {}) as Record<string, unknown>;
  const check = (name: string, v: unknown): number => {
    if (!isFiniteNumber(v) || v <= 0) {
      errs.push(`${name} 必须为正有限数`);
      return NaN;
    }
    if (v > LIMITS.maxParam) errs.push(`${name} 超过幅值上限 ${LIMITS.maxParam}`);
    return v;
  };
  const cfg = {
    pickupCurrent: check("pickupCurrent", o.pickupCurrent),
    tms: check("tms", o.tms),
    resetTime: check("resetTime", o.resetTime),
  };
  if (errs.length > 0) throw new ValidationError(errs);
  return cfg;
}

export function validateSegments(raw: unknown): SegmentInput[] {
  if (!Array.isArray(raw)) throw new ValidationError(["segments 必须为数组"]);
  if (raw.length === 0) throw new ValidationError(["segments 不能为空"]);
  if (raw.length > LIMITS.maxSegments)
    throw new ValidationError([`segments 数量超过上限 ${LIMITS.maxSegments}`]);
  const errs: string[] = [];
  const seen = new Set<string>();
  const out: SegmentInput[] = [];
  raw.forEach((item, i) => {
    const o = (item ?? {}) as Record<string, unknown>;
    const where = `segments[${i}]`;
    if (typeof o.id !== "string" || o.id.length === 0 || o.id.length > LIMITS.maxIdLength) {
      errs.push(`${where}.id 必须为 1..${LIMITS.maxIdLength} 字符的字符串`);
    } else if (seen.has(o.id)) {
      errs.push(`${where}.id "${o.id}" 重复`);
    } else {
      seen.add(o.id);
    }
    if (!isFiniteNumber(o.duration) || o.duration <= 0)
      errs.push(`${where}.duration 必须为正有限数`);
    else if (o.duration > LIMITS.maxDuration)
      errs.push(`${where}.duration 超过上限 ${LIMITS.maxDuration}`);
    if (!isFiniteNumber(o.current) || o.current < 0)
      errs.push(`${where}.current 必须为非负有限数`);
    else if (o.current > LIMITS.maxCurrent)
      errs.push(`${where}.current 超过上限 ${LIMITS.maxCurrent}`);
    if (errs.length === 0 || true) {
      out.push({
        id: typeof o.id === "string" ? o.id : String(o.id ?? ""),
        duration: isFiniteNumber(o.duration) ? o.duration : NaN,
        current: isFiniteNumber(o.current) ? o.current : NaN,
      });
    }
  });
  if (errs.length > 0) throw new ValidationError(errs);
  return out;
}

/**
 * 标准反时限动作时间 T(M) = 0.14*TMS / (M^0.02 - 1)。
 * 使用 expm1/log 避免 M≈1 时幂减一的数值消去。
 * M<=1 返回 null（不动作，进入复归）。结果非有限时抛错。
 */
export function operatingTime(multiple: number, tms: number): number | null {
  if (!(multiple > 1)) return null;
  const denom = Math.expm1(0.02 * Math.log(multiple));
  const t = (0.14 * tms) / denom;
  if (!Number.isFinite(t) || t <= 0) {
    throw new ValidationError([`T(M) 计算结果非有限：M=${multiple}, TMS=${tms}`]);
  }
  return t;
}

/**
 * 执行仿真。输入顺序即时间顺序，从 t=0 累计边界。
 * 跳闸后锁存：后续段不再积分也不复归，processedDuration=0。
 */
export function simulate(cfg: RelayConfig, segments: SegmentInput[]): SimulationResult {
  const results: SegmentResult[] = [];
  let t = 0;
  let z = 0;
  let trip: TripInfo | null = null;

  segments.forEach((seg, seq) => {
    const start = t;
    const end = start + seg.duration;
    const m = seg.current / cfg.pickupCurrent;

    if (trip !== null) {
      results.push({
        segmentId: seg.id, seq, start, end, current: seg.current, multiple: m,
        mode: "latched", operatingTime: null,
        progressBefore: 1, progressAfter: 1, processedDuration: 0, resetToZeroAt: null,
      });
      t = end;
      return;
    }

    const T = operatingTime(m, cfg.tms);
    if (T !== null) {
      // 过流段：dz/dt = 1/T(M)，尚需 (1-z)*T 秒
      const need = (1 - z) * T;
      // 容差吸收浮点舍入：need 略大于 duration 但差距在容差内视为恰在段末
      const tol = TOLERANCE * Math.max(1, seg.duration);
      if (need <= seg.duration + tol) {
        const offset = Math.min(need, seg.duration);
        trip = {
          segmentId: seg.id,
          offsetInSegment: offset,
          tripTime: start + offset,
          progressBefore: z,
          unprocessedSuffix: seg.duration - offset,
        };
        results.push({
          segmentId: seg.id, seq, start, end, current: seg.current, multiple: m,
          mode: "operate", operatingTime: T,
          progressBefore: z, progressAfter: 1, processedDuration: offset,
          resetToZeroAt: null,
        });
        z = 1;
      } else {
        const zAfter = z + seg.duration / T;
        results.push({
          segmentId: seg.id, seq, start, end, current: seg.current, multiple: m,
          mode: "operate", operatingTime: T,
          progressBefore: z, progressAfter: zAfter, processedDuration: seg.duration,
          resetToZeroAt: null,
        });
        z = zAfter;
      }
    } else {
      // 复归段（含 M==1）：dz/dt = -1/Tr，下限 0
      const drop = seg.duration / cfg.resetTime;
      let zAfter: number;
      let resetToZeroAt: number | null = null;
      if (drop >= z && z > 0) {
        resetToZeroAt = start + z * cfg.resetTime;
        zAfter = 0;
      } else {
        zAfter = Math.max(0, z - drop);
      }
      results.push({
        segmentId: seg.id, seq, start, end, current: seg.current, multiple: m,
        mode: "reset", operatingTime: null,
        progressBefore: z, progressAfter: zAfter, processedDuration: seg.duration,
        resetToZeroAt,
      });
      z = zAfter;
    }
    t = end;
  });

  return {
    algoVersion: ALGO_VERSION,
    tolerance: TOLERANCE,
    config: cfg,
    segments: results,
    trip,
    totalDuration: t,
  };
}

export interface IntraSegmentState {
  segmentId: string;
  offset: number;
  absoluteTime: number;
  mode: SegmentMode;
  progress: number;
  /** 在该偏移处是否已处于锁存跳闸状态 */
  tripped: boolean;
}

/**
 * 段内只读查询：用与正式仿真完全相同的公式，从冻结的段结果推算
 * 段内 offset（秒）处的进度。不改变任何已存结果。
 */
export function queryIntraSegment(
  cfg: RelayConfig,
  seg: SegmentResult,
  offset: number,
): IntraSegmentState {
  if (!Number.isFinite(offset) || offset < 0 || offset > seg.end - seg.start) {
    throw new ValidationError([`offset 必须在 [0, ${seg.end - seg.start}] 内`]);
  }
  const abs = seg.start + offset;
  if (seg.mode === "latched") {
    return { segmentId: seg.segmentId, offset, absoluteTime: abs, mode: seg.mode, progress: 1, tripped: true };
  }
  if (seg.mode === "operate") {
    const T = operatingTime(seg.multiple, cfg.tms)!;
    const z = Math.min(1, seg.progressBefore + offset / T);
    const tripped = seg.progressAfter >= 1 && offset >= seg.processedDuration;
    return {
      segmentId: seg.segmentId, offset, absoluteTime: abs, mode: seg.mode,
      progress: tripped ? 1 : z, tripped,
    };
  }
  // reset
  const z = Math.max(0, seg.progressBefore - offset / cfg.resetTime);
  return { segmentId: seg.segmentId, offset, absoluteTime: abs, mode: seg.mode, progress: z, tripped: false };
}

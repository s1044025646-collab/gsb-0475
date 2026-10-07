import { SimError, type Config, type RawSegment } from "./types.ts";

export const LIMITS = {
  ip: { min: 1e-6, max: 1e6 },
  tms: { min: 1e-6, max: 100 },
  tr: { min: 1e-6, max: 1e7 },
  duration: { min: 1e-9, max: 1e7 },
  current: { min: 0, max: 1e9 },
  mMax: 1e6,
  maxSegments: 10000,
  idLength: 128
} as const;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function validateConfig(input: unknown): Config {
  if (typeof input !== "object" || input === null) {
    throw new SimError("CONFIG_INVALID", "配置必须是对象");
  }
  const obj = input as Record<string, unknown>;
  const out: Config = { ip: 0, tms: 0, tr: 0 };
  (["ip", "tms", "tr"] as const).forEach((key) => {
    const v = obj[key];
    if (!isFiniteNumber(v)) {
      throw new SimError("CONFIG_INVALID", `${key} 必须是有限数字`, { field: key });
    }
    const { min, max } = LIMITS[key];
    if (v <= 0 || v < min || v > max) {
      throw new SimError("CONFIG_OUT_OF_RANGE", `${key} 必须为正且在 [${min}, ${max}] 内`, {
        field: key,
        value: v
      });
    }
    out[key] = v;
  });
  return out;
}

export function validateSegments(input: unknown): RawSegment[] {
  if (!Array.isArray(input)) {
    throw new SimError("SEGMENTS_INVALID", "电流段必须是数组");
  }
  if (input.length === 0) {
    throw new SimError("SEGMENTS_EMPTY", "至少需要一个电流段");
  }
  if (input.length > LIMITS.maxSegments) {
    throw new SimError("SEGMENTS_TOO_MANY", `段数超过上限 ${LIMITS.maxSegments}`);
  }
  const seen = new Set<string>();
  const out: RawSegment[] = [];
  input.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new SimError("SEGMENT_INVALID", `第 ${index} 段必须是对象`, { index });
    }
    const seg = raw as Record<string, unknown>;
    const id = seg.id;
    if (typeof id !== "string" || id.trim() === "") {
      throw new SimError("SEGMENT_ID_INVALID", `第 ${index} 段缺少非空字符串 id`, { index });
    }
    if (id.length > LIMITS.idLength) {
      throw new SimError("SEGMENT_ID_TOO_LONG", `第 ${index} 段 id 超长`, { index });
    }
    if (seen.has(id)) {
      throw new SimError("SEGMENT_ID_DUPLICATE", `段 id 重复: ${id}`, { index, id });
    }
    seen.add(id);
    const { duration, current } = seg;
    if (!isFiniteNumber(duration) || duration <= 0 || duration < LIMITS.duration.min ||
      duration > LIMITS.duration.max) {
      throw new SimError("SEGMENT_DURATION_INVALID",
        `段 ${id} 的 duration 必须为正有限且在 [${LIMITS.duration.min}, ${LIMITS.duration.max}] 内`,
        { id });
    }
    if (!isFiniteNumber(current) || current < 0 || current > LIMITS.current.max) {
      throw new SimError("SEGMENT_CURRENT_INVALID",
        `段 ${id} 的 current 必须为非负有限且不超过 ${LIMITS.current.max}`,
        { id });
    }
    out.push({ id, duration, current });
  });
  return out;
}

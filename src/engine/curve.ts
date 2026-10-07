import { LIMITS } from "./validate.ts";
import { SimError } from "./types.ts";

/**
 * 标准反时限（IEC 正常反时限常数 0.14）完整动作时间：
 *   T(M) = 0.14 * TMS / (M^0.02 - 1),  M > 1
 * 近 M=1 时用 expm1 计算 M^0.02 - 1 = expm1(0.02 ln M)，避免直接幂减一的消去误差。
 * M <= 1 不属于动作区，调用方不得用本函数（返回 null 语义由调用方处理）。
 */
export function operateTime(m: number, tms: number): number {
  if (!(m > 1)) {
    throw new SimError("M_NOT_ABOVE_PICKUP", "仅 M>1 可计算动作时间", { m });
  }
  if (m > LIMITS.mMax) {
    throw new SimError("M_OUT_OF_RANGE", `倍数 M=${m} 超过上限 ${LIMITS.mMax}`, { m });
  }
  const x = 0.02 * Math.log(m);
  if (!Number.isFinite(x)) {
    throw new SimError("NUMERIC_NONFINITE", "ln(M) 中间结果非有限", { m });
  }
  const denom = Math.expm1(x);
  if (!Number.isFinite(denom) || denom <= 0) {
    throw new SimError("NUMERIC_NONFINITE", "M^0.02-1 中间结果无效", { m, denom });
  }
  const t = (0.14 * tms) / denom;
  if (!Number.isFinite(t) || t <= 0) {
    throw new SimError("NUMERIC_NONFINITE", "动作时间计算结果无效", { m, t });
  }
  return t;
}

/** 动作速率 dz/dt = 1/T(M)。 */
export function operateRate(m: number, tms: number): number {
  return 1 / operateTime(m, tms);
}

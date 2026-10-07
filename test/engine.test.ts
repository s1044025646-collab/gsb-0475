import { test } from "node:test";
import assert from "node:assert/strict";
import {
  simulate,
  operatingTime,
  validateConfig,
  validateSegments,
  queryIntraSegment,
  ValidationError,
  RelayConfig,
  SegmentInput,
} from "../src/engine.js";

const CFG: RelayConfig = { pickupCurrent: 1, tms: 1, resetTime: 10 };
const T2 = operatingTime(2, 1)!;
const EPS = 1e-9;

function close(a: number, b: number, eps = EPS): void {
  assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
}

/**
 * 独立核验模型：把进度 z(t) 看作分段线性函数（每段斜率 1/T 或 -1/Tr），
 * 手算各段端点值并求 z 与 1 的首个交点。与引擎实现完全分离。
 */
function handCheck(cfg: RelayConfig, segs: SegmentInput[]): { tripTime: number | null; finalZ: number } {
  let t = 0;
  let z = 0;
  for (const s of segs) {
    const m = s.current / cfg.pickupCurrent;
    if (m > 1) {
      // 手算斜率：直接用幂公式（与引擎的 expm1 路径不同写法）
      const T = (0.14 * cfg.tms) / (Math.pow(m, 0.02) - 1);
      const slope = 1 / T;
      if (z + slope * s.duration >= 1) {
        return { tripTime: t + (1 - z) / slope, finalZ: 1 };
      }
      z += slope * s.duration;
    } else {
      z = Math.max(0, z - s.duration / cfg.resetTime);
    }
    t += s.duration;
  }
  return { tripTime: null, finalZ: z };
}

test("T(2) 与标准公式一致", () => {
  close(T2, 0.14 / (Math.pow(2, 0.02) - 1), 1e-12);
});

test("M 接近 1 时无明显数值消去（expm1 路径）", () => {
  const m = 1 + 1e-9;
  const t = operatingTime(m, 1)!;
  // 解析近似：0.14 / (0.02 * ln(m))
  const approx = 0.14 / (0.02 * Math.log(m));
  assert.ok(Math.abs(t - approx) / approx < 1e-6, `${t} vs ${approx}`);
  assert.ok(Number.isFinite(t));
});

test("M<=1 不代入公式，返回 null", () => {
  assert.equal(operatingTime(1, 1), null);
  assert.equal(operatingTime(0.5, 1), null);
  assert.equal(operatingTime(0, 1), null);
});

test("恒定 2*Ip：短于 T(2) 不跳闸，等于/大于都在 T(2) 跳闸", () => {
  const short = simulate(CFG, [{ id: "s", duration: 0.5 * T2, current: 2 }]);
  assert.equal(short.trip, null);
  close(short.segments[0]!.progressAfter, 0.5);

  const equal = simulate(CFG, [{ id: "s", duration: T2, current: 2 }]);
  assert.ok(equal.trip);
  close(equal.trip!.tripTime, T2);
  close(equal.trip!.unprocessedSuffix, 0);

  const long = simulate(CFG, [{ id: "s", duration: 2 * T2, current: 2 }]);
  assert.ok(long.trip);
  close(long.trip!.tripTime, T2);
  close(long.trip!.unprocessedSuffix, T2);
});

test("过流→零电流复归→再过流：进度延续，不重新计完整动作时间", () => {
  const segs: SegmentInput[] = [
    { id: "a", duration: 0.4 * T2, current: 2 },
    { id: "b", duration: 0.2 * CFG.resetTime, current: 0 },
    { id: "c", duration: T2, current: 2 },
  ];
  const r = simulate(CFG, segs);
  close(r.segments[0]!.progressAfter, 0.4);
  close(r.segments[1]!.progressAfter, 0.2);
  assert.ok(r.trip);
  assert.equal(r.trip!.segmentId, "c");
  // 还需 (1-0.2)*T(2) = 0.8*T(2)
  close(r.trip!.offsetInSegment, 0.8 * T2);
  close(r.trip!.progressBefore, 0.2);
});

test("恰等于起动电流属于复归", () => {
  const r = simulate(CFG, [
    { id: "a", duration: 0.5 * T2, current: 2 },
    { id: "b", duration: 0.1 * CFG.resetTime, current: 1 },
  ]);
  assert.equal(r.segments[1]!.mode, "reset");
  close(r.segments[1]!.progressAfter, 0.4);
});

test("恰在段末达到 1 算本段触发，不被下一段低电流救回", () => {
  const r = simulate(CFG, [
    { id: "a", duration: T2, current: 2 },
    { id: "b", duration: 5, current: 0 },
  ]);
  assert.ok(r.trip);
  assert.equal(r.trip!.segmentId, "a");
  assert.equal(r.segments[1]!.mode, "latched");
  assert.equal(r.segments[1]!.progressAfter, 1);
});

test("长期复归降到零后保持零，并报告清零时刻", () => {
  const r = simulate(CFG, [
    { id: "a", duration: 0.3 * T2, current: 2 },
    { id: "b", duration: 10 * CFG.resetTime, current: 0 },
    { id: "c", duration: 5, current: 0 },
  ]);
  const b = r.segments[1]!;
  assert.equal(b.progressAfter, 0);
  assert.ok(b.resetToZeroAt !== null);
  close(b.resetToZeroAt!, b.start + 0.3 * CFG.resetTime);
  assert.equal(r.segments[2]!.progressAfter, 0);
  assert.equal(r.segments[2]!.resetToZeroAt, null);
});

test("不同倍数切换共享进度", () => {
  const T3 = operatingTime(3, 1)!;
  const r = simulate(CFG, [
    { id: "a", duration: 0.5 * T2, current: 2 },
    { id: "b", duration: 0.4 * T3, current: 3 },
  ]);
  assert.equal(r.trip, null);
  close(r.segments[1]!.progressBefore, 0.5);
  close(r.segments[1]!.progressAfter, 0.9);
  // 再补 0.5*T3：0.9 + 0.5 > 1，段内触发，尚需 0.1*T3
  const r2 = simulate(CFG, [
    { id: "a", duration: 0.5 * T2, current: 2 },
    { id: "b", duration: 0.5 * T3, current: 3 },
  ]);
  assert.ok(r2.trip);
  assert.equal(r2.trip!.segmentId, "b");
  // z0=0.5，尚需 (1-0.5)*T3
  close(r2.trip!.offsetInSegment, 0.5 * T3);
});

test("单段拆分为两段结果不变", () => {
  const one = simulate(CFG, [{ id: "x", duration: 1.5 * T2, current: 2 }]);
  const two = simulate(CFG, [
    { id: "x1", duration: 0.6 * T2, current: 2 },
    { id: "x2", duration: 0.9 * T2, current: 2 },
  ]);
  assert.ok(one.trip && two.trip);
  close(one.trip!.tripTime, two.trip!.tripTime);
});

test("锁存后低电流不解锁、不复归", () => {
  const r = simulate(CFG, [
    { id: "a", duration: 1.2 * T2, current: 2 },
    { id: "b", duration: 100, current: 0 },
    { id: "c", duration: 100, current: 0.5 },
  ]);
  assert.ok(r.trip);
  for (const s of r.segments.slice(1)) {
    assert.equal(s.mode, "latched");
    assert.equal(s.progressAfter, 1);
    assert.equal(s.processedDuration, 0);
  }
});

test("与独立分段线性手算核验一致（首个交点）", () => {
  const scenarios: SegmentInput[][] = [
    [
      { id: "a", duration: 0.4 * T2, current: 2 },
      { id: "b", duration: 0.2 * CFG.resetTime, current: 0 },
      { id: "c", duration: T2, current: 2 },
    ],
    [
      { id: "a", duration: 0.3 * T2, current: 2 },
      { id: "b", duration: 0.1 * CFG.resetTime, current: 0.5 },
      { id: "a2", duration: 0.4 * T2, current: 2 },
      { id: "b2", duration: 0.05 * CFG.resetTime, current: 0 },
      { id: "c", duration: T2, current: 2 },
    ],
    [{ id: "a", duration: 0.9 * T2, current: 2 }],
  ];
  for (const segs of scenarios) {
    const r = simulate(CFG, segs);
    const h = handCheck(CFG, segs);
    if (h.tripTime === null) {
      assert.equal(r.trip, null);
      close(r.segments.at(-1)!.progressAfter, h.finalZ);
    } else {
      assert.ok(r.trip);
      close(r.trip!.tripTime, h.tripTime, 1e-9);
    }
  }
});

test("段内只读查询与正式结果一致", () => {
  const segs: SegmentInput[] = [
    { id: "a", duration: 0.4 * T2, current: 2 },
    { id: "b", duration: 0.2 * CFG.resetTime, current: 0 },
    { id: "c", duration: T2, current: 2 },
  ];
  const r = simulate(CFG, segs);
  // 过流段中点
  const q1 = queryIntraSegment(CFG, r.segments[0]!, 0.2 * T2);
  close(q1.progress, 0.2);
  assert.equal(q1.tripped, false);
  // 复归段中点
  const q2 = queryIntraSegment(CFG, r.segments[1]!, 0.1 * CFG.resetTime);
  close(q2.progress, 0.3);
  // 触发段：跳闸偏移前/后
  const tripOffset = r.trip!.offsetInSegment;
  const q3 = queryIntraSegment(CFG, r.segments[2]!, tripOffset / 2);
  assert.equal(q3.tripped, false);
  const q4 = queryIntraSegment(CFG, r.segments[2]!, tripOffset);
  assert.equal(q4.tripped, true);
  assert.equal(q4.progress, 1);
});

test("参数校验：坏配置与坏段整体拒绝", () => {
  assert.throws(() => validateConfig({ pickupCurrent: 0, tms: 1, resetTime: 1 }), ValidationError);
  assert.throws(() => validateConfig({ pickupCurrent: 1, tms: -1, resetTime: 1 }), ValidationError);
  assert.throws(() => validateConfig({ pickupCurrent: 1, tms: 1, resetTime: Infinity }), ValidationError);
  assert.throws(
    () => validateSegments([{ id: "a", duration: 1, current: 2 }, { id: "a", duration: 1, current: 2 }]),
    ValidationError,
  );
  assert.throws(() => validateSegments([{ id: "a", duration: 0, current: 2 }]), ValidationError);
  assert.throws(() => validateSegments([{ id: "a", duration: 1, current: -1 }]), ValidationError);
  assert.throws(() => validateSegments([{ id: "a", duration: 1, current: NaN }]), ValidationError);
  assert.throws(() => validateSegments([]), ValidationError);
});

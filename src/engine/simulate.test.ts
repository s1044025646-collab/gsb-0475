import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, stateAtTime, compareRuns } from "./simulate.ts";
import { operateTime } from "./curve.ts";
import { T2 } from "./scenarios.ts";
import type { RawSegment } from "./types.ts";

const cfg = { ip: 100, tms: 1, tr: 5 };
const seg = (id: string, duration: number, current: number): RawSegment => ({ id, duration, current });
const T = T2(1);

test("两倍电流：短于 T(2) 不跳闸，进度等于时长比例", () => {
  const r = simulate(cfg, [seg("s1", 0.5 * T, 200)]);
  assert.equal(r.tripped, false);
  assert.ok(Math.abs(r.finalZ - 0.5) < 1e-12);
});

test("两倍电流：恰等于 T(2) 在段末跳闸，时刻为 T(2)", () => {
  const r = simulate(cfg, [seg("s1", T, 200)]);
  assert.equal(r.tripped, true);
  assert.ok(Math.abs(r.trip!.tripTime - T) < 1e-10);
  assert.ok(Math.abs(r.trip!.offsetInSegment - T) < 1e-10);
  assert.equal(r.trip!.segmentId, "s1");
});

test("两倍电流：长于 T(2) 仍在 T(2) 跳闸，后缀未处理时长正确", () => {
  const r = simulate(cfg, [seg("s1", 2 * T, 200)]);
  assert.equal(r.tripped, true);
  assert.ok(Math.abs(r.trip!.tripTime - T) < 1e-9);
  assert.ok(Math.abs(r.segments[0]!.unprocessedSuffix - T) < 1e-9);
  assert.ok(Math.abs(r.unprocessedDuration - T) < 1e-9);
});

test("积累-复归-再过流：尚需 (1-z0)*T 而非完整 T", () => {
  const r = simulate(cfg, [
    seg("a", 0.4 * T, 200),
    seg("b", 0.2 * cfg.tr, 0),
    seg("c", T, 200)
  ]);
  assert.ok(Math.abs(r.segments[0]!.zAfter - 0.4) < 1e-12);
  assert.ok(Math.abs(r.segments[1]!.zAfter - 0.2) < 1e-12);
  assert.equal(r.tripped, true);
  // 跳闸时刻 = 0.4T + 0.2Tr + 0.8T
  const expectTrip = 0.4 * T + 0.2 * cfg.tr + 0.8 * T;
  assert.ok(Math.abs(r.trip!.tripTime - expectTrip) < 1e-9,
    `${r.trip!.tripTime} vs ${expectTrip}`);
  assert.ok(Math.abs(r.trip!.offsetInSegment - 0.8 * T) < 1e-9);
});

test("M=1 等于起动电流按复归处理", () => {
  const r = simulate(cfg, [seg("a", 0.5 * T, 200), seg("b", cfg.tr, 100)]);
  assert.equal(r.segments[1]!.mode, "RESET");
  assert.equal(r.finalZ, 0);
  assert.ok(r.segments[1]!.zeroResetAt !== null);
});

test("段末达到一由该段触发，下一段低电流不能复归救回", () => {
  const r = simulate(cfg, [seg("a", T, 200), seg("b", 100, 0)]);
  assert.equal(r.tripped, true);
  assert.equal(r.trip!.segmentId, "a");
  assert.equal(r.finalZ, 1);
  assert.equal(r.segments[1]!.processedDuration, 0);
  assert.equal(r.segments[1]!.zAfter, 1);
});

test("长期复归：到零后保持零并记录清零时刻", () => {
  const r = simulate(cfg, [
    seg("a", 0.5 * T, 200),
    seg("b", 10 * cfg.tr, 0),
    seg("c", 1, 0)
  ]);
  assert.equal(r.finalZ, 0);
  const resetAt = r.segments[1]!.zeroResetAt!;
  assert.ok(Math.abs(resetAt - (0.5 * T + 0.5 * cfg.tr)) < 1e-9);
  assert.equal(r.segments[2]!.zBefore, 0);
  assert.equal(r.segments[2]!.zAfter, 0);
  assert.equal(r.segments[2]!.zeroResetAt, null);
});

test("不同倍数切换：进度按各自 1/T(M) 累加", () => {
  const tFull3 = operateTime(3, 1);
  const r = simulate(cfg, [
    seg("a", 0.5 * T, 200),
    seg("b", tFull3, 300)
  ]);
  assert.equal(r.tripped, true);
  assert.ok(Math.abs(r.trip!.offsetInSegment - 0.5 * tFull3) < 1e-9);
});

test("单段拆分不变性：拆分点不改变跳闸时刻", () => {
  const one = simulate(cfg, [seg("a", 2 * T, 200)]);
  const split = simulate(cfg, [
    seg("a", 0.37 * T, 200),
    seg("b", 0.63 * T, 200),
    seg("c", T, 200)
  ]);
  assert.ok(Math.abs(one.trip!.tripTime - split.trip!.tripTime) < 1e-9);
  assert.equal(split.trip!.segmentId, "b");
});

test("锁存后任何电流段不再积分、不解锁", () => {
  const r = simulate(cfg, [seg("a", T, 200), seg("b", 1000, 0), seg("c", 5, 300)]);
  assert.equal(r.tripped, true);
  assert.equal(r.finalZ, 1);
  assert.equal(r.segments[2]!.zBefore, 1);
  assert.equal(r.segments[2]!.zAfter, 1);
});

test("stateAtTime 只读查询与冻结结果一致，跳闸后锁存", () => {
  const r = simulate(cfg, [seg("a", 0.4 * T, 200), seg("b", 1, 0), seg("c", T, 200)]);
  assert.ok(Math.abs(stateAtTime(r, 0.2 * T).z - 0.2) < 1e-12);
  const afterReset = stateAtTime(r, 0.4 * T + 1);
  assert.ok(Math.abs(afterReset.z - (0.4 - 1 / cfg.tr)) < 1e-12);
  assert.equal(stateAtTime(r, r.trip!.tripTime).mode, "LATCHED");
  assert.equal(stateAtTime(r, r.totalDuration + 999).z, 1);
});

test("比较两份历程：更强电流先跳闸", () => {
  const weak = simulate(cfg, [seg("a", 5 * T, 200)]);
  const strong = simulate(cfg, [seg("a", 5 * T, 400)]);
  const cmp = compareRuns(weak, strong);
  const weakTrip = weak.trip!.tripTime;
  const strongTrip = strong.trip!.tripTime;
  assert.ok(strongTrip < weakTrip, `${strongTrip} < ${weakTrip}`);
  assert.equal(cmp.earlierTripRun, "B");
  assert.ok(Math.abs((cmp.tripTimeDelta ?? 0) - (strongTrip - weakTrip)) < 1e-9);
  assert.ok((cmp.tripTimeDelta ?? 0) < 0);
});

test("校验：空段、重复 id、零时长、负电流、坏配置整体拒绝", () => {
  const code = (c: string) => (e: Error & { code?: string }) => e.code === c;
  assert.throws(() => simulate(cfg, []), code("SEGMENTS_EMPTY"));
  assert.throws(() => simulate(cfg, [seg("x", 1, 0), seg("x", 1, 0)]), code("SEGMENT_ID_DUPLICATE"));
  assert.throws(() => simulate(cfg, [seg("x", 0, 10)]), code("SEGMENT_DURATION_INVALID"));
  assert.throws(() => simulate(cfg, [seg("x", 1, -1)]), code("SEGMENT_CURRENT_INVALID"));
  assert.throws(() => simulate({ ip: 0, tms: 1, tr: 1 }, [seg("x", 1, 1)]), code("CONFIG_OUT_OF_RANGE"));
  assert.throws(() => simulate({ ip: 1, tms: 1, tr: 1 }, [seg("x", 1, NaN)]), code("SEGMENT_CURRENT_INVALID"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { operateTime } from "./curve.ts";
import { T2 } from "./scenarios.ts";

test("T(2) 对 TMS=1 约 10.029s", () => {
  assert.ok(Math.abs(T2(1) - 10.0294) < 0.01, `got ${T2(1)}`);
});

test("近 M=1 用 expm1 仍给出大而有限的动作时间（无消去异常）", () => {
  for (const m of [1 + 1e-10, 1 + 1e-6, 1 + 1e-3, 1.01]) {
    const t = operateTime(m, 1);
    assert.ok(Number.isFinite(t) && t > 0, `M=${m} t=${t}`);
  }
  const tNear = operateTime(1 + 1e-10, 1);
  assert.ok(tNear > 1e8, `近门槛动作时间应很大, got ${tNear}`);
});

test("TMS 线性缩放动作时间", () => {
  assert.ok(Math.abs(operateTime(2, 2) - 2 * operateTime(2, 1)) < 1e-12);
});

test("M<=1 拒绝计算动作时间", () => {
  assert.throws(() => operateTime(1, 1), (e: Error & { code?: string }) => e.code === "M_NOT_ABOVE_PICKUP");
  assert.throws(() => operateTime(0.5, 1), (e: Error & { code?: string }) => e.code === "M_NOT_ABOVE_PICKUP");
});

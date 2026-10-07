import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";

const dbPath = join(tmpdir(), `idmt-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);

after(() => {
  try { rmSync(dbPath); } catch { /* ignore */ }
});

test("幂等重复请求复用冻结结果，且重启后可核对跳闸时刻", () => {
  const cfg = { ip: 100, tms: 1, tr: 5 };
  const segs = [{ id: "s1", duration: 99, current: 200 }];
  const store1 = new Store(dbPath);
  const first = store1.run(cfg, segs, { runId: "run-fixed", source: "test" });
  assert.equal(first.reused, false);
  const again = store1.run(cfg, segs);
  assert.equal(again.reused, true);
  assert.equal(again.runId, "run-fixed");

  // 坏输入不写入
  assert.throws(() => store1.run(cfg, []));
  assert.equal(store1.list().length, 1);
  store1.close();

  // 模拟服务重启
  const store2 = new Store(dbPath);
  const rec = store2.get("run-fixed")!;
  const result = JSON.parse(rec.resultJson);
  assert.equal(result.tripped, true);
  assert.ok(result.trip.tripTime > 0 && result.trip.tripTime < 99);
  assert.ok(rec.algoVersion && rec.toleranceVersion);
  store2.close();
});

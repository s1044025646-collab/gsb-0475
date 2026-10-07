import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { simulate, RelayConfig, SegmentInput } from "../src/engine.js";

const CFG: RelayConfig = { pickupCurrent: 1, tms: 1, resetTime: 10 };
const SEGS: SegmentInput[] = [
  { id: "a", duration: 5, current: 2 },
  { id: "b", duration: 5, current: 0 },
];

test("保存后可核对冻结的跳闸时刻（模拟重启：新建 Store 实例）", () => {
  const store = new Store(":memory:");
  const result = simulate(CFG, SEGS);
  const configId = store.saveConfig(CFG);
  const [runId] = store.saveRun(configId, SEGS, result, "test", null);
  const loaded = store.getRun(runId)!;
  assert.equal(loaded.algoVersion, result.algoVersion);
  assert.deepEqual(loaded.result.trip, result.trip);
  assert.deepEqual(loaded.inputs, SEGS);
  assert.equal(loaded.result.segments.length, 2);
  store.close();
});

test("幂等：相同 requestKey 返回已有运行，不重复写入", () => {
  const store = new Store(":memory:");
  const result = simulate(CFG, SEGS);
  const configId = store.saveConfig(CFG);
  const [id1, created1] = store.saveRun(configId, SEGS, result, "test", "key-1");
  const [id2, created2] = store.saveRun(configId, SEGS, result, "test", "key-1");
  assert.equal(id1, id2);
  assert.equal(created1, true);
  assert.equal(created2, false);
  assert.equal(store.listRuns().length, 1);
  store.close();
});

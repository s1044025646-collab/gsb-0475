import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ALGO_VERSION, TOLERANCE_VERSION, type SimulationResult } from "../engine/types.ts";
import { simulate } from "../engine/simulate.ts";

export interface RunRecord {
  runId: string;
  name: string | null;
  createdAt: string;
  configJson: string;
  segmentsJson: string;
  resultJson: string;
  algoVersion: string;
  toleranceVersion: string;
  inputHash: string;
  source: string;
}

function sha(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

interface RunRow {
  run_id: string;
  name: string | null;
  created_at: string;
  config_json: string;
  segments_json: string;
  result_json: string;
  algo_version: string;
  tolerance_version: string;
  input_hash: string;
  source: string;
}

function toRecord(r: RunRow): RunRecord {
  return {
    runId: r.run_id, name: r.name, createdAt: r.created_at,
    configJson: r.config_json, segmentsJson: r.segments_json, resultJson: r.result_json,
    algoVersion: r.algo_version, toleranceVersion: r.tolerance_version,
    inputHash: r.input_hash, source: r.source
  };
}

export function parseResult(rec: RunRecord): SimulationResult {
  return JSON.parse(rec.resultJson) as SimulationResult;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const abs = isAbsolute(dbPath) ? dbPath : resolve(process.cwd(), dbPath);
    mkdirSync(dirname(abs), { recursive: true });
    this.db = new DatabaseSync(abs);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        name TEXT,
        created_at TEXT NOT NULL,
        config_json TEXT NOT NULL,
        segments_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        algo_version TEXT NOT NULL,
        tolerance_version TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'api'
      );
      CREATE INDEX IF NOT EXISTS idx_runs_hash ON runs(input_hash);
      CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);
    `);
  }

  /**
   * 幂等执行：相同配置+段（同算法/容差版本下哈希一致）返回已冻结结果，不重复写入。
   * 校验与计算先于写库完成，坏输入整体拒绝，绝不部分写入。
   */
  run(config: unknown, segments: unknown, opts: { runId?: string; name?: string; source?: string } = {}):
    RunRecord & { reused: boolean } {
    const probe = simulate(config, segments);
    const configJson = JSON.stringify(probe.config);
    const segmentsJson = JSON.stringify(segments);
    const inputHash = sha(configJson + segmentsJson + ALGO_VERSION + TOLERANCE_VERSION);
    const existing = this.db.prepare("SELECT * FROM runs WHERE input_hash = ?").get(inputHash) as
      | RunRow
      | undefined;
    if (existing) {
      return { ...toRecord(existing), reused: true };
    }
    const runId = opts.runId ?? `run_${Date.now().toString(36)}_${inputHash.slice(0, 10)}`;
    if (this.db.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(runId)) {
      throw Object.assign(new Error("runId 已存在"), { code: "RUN_ID_EXISTS" });
    }
    const record: RunRecord = {
      runId,
      name: opts.name ?? null,
      createdAt: new Date().toISOString(),
      configJson,
      segmentsJson,
      resultJson: JSON.stringify(probe),
      algoVersion: ALGO_VERSION,
      toleranceVersion: TOLERANCE_VERSION,
      inputHash,
      source: opts.source ?? "api"
    };
    this.db.prepare(`INSERT INTO runs
      (run_id, name, created_at, config_json, segments_json, result_json, algo_version, tolerance_version, input_hash, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.runId, record.name, record.createdAt, record.configJson, record.segmentsJson,
      record.resultJson, record.algoVersion, record.toleranceVersion, record.inputHash, record.source
    );
    return { ...record, reused: false };
  }

  get(runId: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as RunRow | undefined;
    return row ? toRecord(row) : null;
  }

  list(): Array<Pick<RunRecord, "runId" | "name" | "createdAt" | "source" | "inputHash">> {
    const rows = this.db.prepare(
      "SELECT run_id, name, created_at, source, input_hash FROM runs ORDER BY created_at DESC"
    ).all() as unknown as RunRow[];
    return rows.map((r) => ({
      runId: r.run_id, name: r.name, createdAt: r.created_at,
      source: r.source, inputHash: r.input_hash
    }));
  }

  close(): void {
    this.db.close();
  }
}

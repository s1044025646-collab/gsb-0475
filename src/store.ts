/**
 * SQLite 持久层：保存配置、原始段序列、算法/容差版本、冻结的仿真结果。
 * 使用 Node 内置 node:sqlite，无原生编译依赖。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  ALGO_VERSION,
  TOLERANCE,
  RelayConfig,
  SegmentInput,
  SegmentResult,
  SimulationResult,
  TripInfo,
} from "./engine.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pickup_current REAL NOT NULL,
  tms REAL NOT NULL,
  reset_time REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id INTEGER NOT NULL REFERENCES configs(id),
  request_key TEXT UNIQUE,
  algo_version TEXT NOT NULL,
  tolerance REAL NOT NULL,
  source TEXT NOT NULL,
  total_duration REAL NOT NULL,
  trip_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS segments (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  seg_id TEXT NOT NULL,
  duration REAL NOT NULL,
  current REAL NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS results (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  seg_id TEXT NOT NULL,
  start REAL NOT NULL,
  end REAL NOT NULL,
  current REAL NOT NULL,
  multiple REAL NOT NULL,
  mode TEXT NOT NULL,
  operating_time REAL,
  progress_before REAL NOT NULL,
  progress_after REAL NOT NULL,
  processed_duration REAL NOT NULL,
  reset_to_zero_at REAL,
  PRIMARY KEY (run_id, seq)
);
`;

export interface StoredRun {
  runId: number;
  configId: number;
  config: RelayConfig;
  algoVersion: string;
  tolerance: number;
  source: string;
  createdAt: string;
  inputs: SegmentInput[];
  result: SimulationResult;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  saveConfig(cfg: RelayConfig): number {
    const r = this.db
      .prepare("INSERT INTO configs (pickup_current, tms, reset_time) VALUES (?,?,?)")
      .run(cfg.pickupCurrent, cfg.tms, cfg.resetTime);
    return Number(r.lastInsertRowid);
  }

  getConfig(id: number): RelayConfig | null {
    const row = this.db
      .prepare("SELECT pickup_current, tms, reset_time FROM configs WHERE id=?")
      .get(id) as { pickup_current: number; tms: number; reset_time: number } | undefined;
    if (!row) return null;
    return { pickupCurrent: row.pickup_current, tms: row.tms, resetTime: row.reset_time };
  }

  /**
   * 幂等保存一次运行：requestKey 相同则返回已有运行，不重复写入。
   * 返回 [runId, 是否新建]。
   */
  saveRun(
    configId: number,
    inputs: SegmentInput[],
    result: SimulationResult,
    source: string,
    requestKey: string | null,
  ): [number, boolean] {
    if (requestKey !== null) {
      const existing = this.db
        .prepare("SELECT id FROM runs WHERE request_key=?")
        .get(requestKey) as { id: number } | undefined;
      if (existing) return [existing.id, false];
    }
    // 事务：坏段已在写入前整体校验，这里保证运行记录与段/结果原子落库
    this.db.exec("BEGIN");
    try {
      const r = this.db
        .prepare(
          "INSERT INTO runs (config_id, request_key, algo_version, tolerance, source, total_duration, trip_json) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          configId,
          requestKey,
          ALGO_VERSION,
          TOLERANCE,
          source,
          result.totalDuration,
          result.trip ? JSON.stringify(result.trip) : null,
        );
      const runId = Number(r.lastInsertRowid);
      const segStmt = this.db.prepare(
        "INSERT INTO segments (run_id, seq, seg_id, duration, current) VALUES (?,?,?,?,?)",
      );
      inputs.forEach((s, i) => segStmt.run(runId, i, s.id, s.duration, s.current));
      const resStmt = this.db.prepare(
        `INSERT INTO results (run_id, seq, seg_id, start, end, current, multiple, mode,
           operating_time, progress_before, progress_after, processed_duration, reset_to_zero_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const s of result.segments) {
        resStmt.run(
          runId, s.seq, s.segmentId, s.start, s.end, s.current, s.multiple, s.mode,
          s.operatingTime, s.progressBefore, s.progressAfter, s.processedDuration,
          s.resetToZeroAt,
        );
      }
      this.db.exec("COMMIT");
      return [runId, true];
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getRun(runId: number): StoredRun | null {
    const run = this.db
      .prepare(
        `SELECT r.id, r.config_id, r.algo_version, r.tolerance, r.source, r.total_duration,
                r.trip_json, r.created_at,
                c.pickup_current, c.tms, c.reset_time
         FROM runs r JOIN configs c ON c.id = r.config_id WHERE r.id=?`,
      )
      .get(runId) as Record<string, unknown> | undefined;
    if (!run) return null;
    const config: RelayConfig = {
      pickupCurrent: run.pickup_current as number,
      tms: run.tms as number,
      resetTime: run.reset_time as number,
    };
    const inputs = (
      this.db
        .prepare("SELECT seg_id, duration, current FROM segments WHERE run_id=? ORDER BY seq")
        .all(runId) as unknown as Array<Record<string, unknown>>
    ).map((r) => ({ id: r.seg_id as string, duration: r.duration as number, current: r.current as number }));
    const segments: SegmentResult[] = (
      this.db
        .prepare("SELECT * FROM results WHERE run_id=? ORDER BY seq")
        .all(runId) as unknown as Array<Record<string, unknown>>
    ).map((r) => ({
      segmentId: r.seg_id as string,
      seq: r.seq as number,
      start: r.start as number,
      end: r.end as number,
      current: r.current as number,
      multiple: r.multiple as number,
      mode: r.mode as SegmentResult["mode"],
      operatingTime: r.operating_time as number | null,
      progressBefore: r.progress_before as number,
      progressAfter: r.progress_after as number,
      processedDuration: r.processed_duration as number,
      resetToZeroAt: r.reset_to_zero_at as number | null,
    }));
    const trip = run.trip_json ? (JSON.parse(run.trip_json as string) as TripInfo) : null;
    return {
      runId,
      configId: run.config_id as number,
      config,
      algoVersion: run.algo_version as string,
      tolerance: run.tolerance as number,
      source: run.source as string,
      createdAt: run.created_at as string,
      inputs,
      result: {
        algoVersion: run.algo_version as string,
        tolerance: run.tolerance as number,
        config,
        segments,
        trip,
        totalDuration: run.total_duration as number,
      },
    };
  }

  listRuns(): Array<{ id: number; source: string; createdAt: string; tripped: boolean }> {
    return (
      this.db
        .prepare("SELECT id, source, created_at, trip_json FROM runs ORDER BY id")
        .all() as unknown as Array<Record<string, unknown>>
    ).map((r) => ({
      id: r.id as number,
      source: r.source as string,
      createdAt: r.created_at as string,
      tripped: r.trip_json !== null,
    }));
  }
}

export function defaultDbPath(): string {
  return path.join(process.cwd(), "data", "relay.db");
}

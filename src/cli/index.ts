#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store, parseResult } from "../db/store.ts";
import { SimError } from "../engine/types.ts";
import { stateAtTime, compareRuns } from "../engine/simulate.ts";
import { segmentsToCSV, resultToJSON } from "../engine/export.ts";

const DB_PATH = process.env.IDMT_DB_PATH ??
  resolve(process.env.IDMT_DATA_DIR ?? resolve(process.cwd(), "data"), "idmt.sqlite");

const USAGE = `idmt-sim — 反时限过流动作积分仿真 CLI

用法:
  idmt-sim validate <input.json>
  idmt-sim run <input.json> [--name N] [--run-id ID] [--out result.json]
  idmt-sim list
  idmt-sim get <runId>
  idmt-sim state <runId> <time>
  idmt-sim compare <runIdA> <runIdB>
  idmt-sim export <runId> <csv|json> <outFile>
  idmt-sim serve [port]

input.json 形如:
  { "name": "可选", "config": {"ip":100,"tms":1,"tr":5},
    "segments": [{"id":"s1","duration":2.0,"current":200}] }

环境变量: IDMT_DATA_DIR (默认 ./data), IDMT_DB_PATH, PORT
`;

function loadJson(file: string): { config?: unknown; segments?: unknown; name?: string } {
  return JSON.parse(readFileSync(resolve(file), "utf8")) as never;
}

function opt(args: string[], key: string): string | undefined {
  const i = args.indexOf(key);
  return i >= 0 ? args[i + 1] : undefined;
}

function fail(err: unknown): never {
  if (err instanceof SimError) {
    console.error(`错误 [${err.code}] ${err.message}`);
    if (err.details !== undefined) console.error(JSON.stringify(err.details));
  } else {
    console.error("错误:", (err as Error).message);
  }
  process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const store = new Store(DB_PATH);
  try {
    switch (cmd) {
      case "validate": {
        const input = loadJson(args[0] ?? "");
        const { validateConfig, validateSegments } = await import("../engine/validate.ts");
        const config = input.config === undefined ? undefined : validateConfig(input.config);
        const segments = input.segments === undefined ? undefined : validateSegments(input.segments);
        console.log(JSON.stringify({ valid: true, config, segmentCount: segments?.length }, null, 2));
        break;
      }
      case "run": {
        const input = loadJson(args[0] ?? "");
        const rec = store.run(input.config, input.segments, {
          runId: opt(args, "--run-id"),
          name: opt(args, "--name") ?? input.name,
          source: "cli"
        });
        const result = parseResult(rec);
        const out = opt(args, "--out");
        if (out) writeFileSync(resolve(out), resultToJSON(result), "utf8");
        console.log(JSON.stringify({
          runId: rec.runId, reused: rec.reused, tripped: result.tripped,
          trip: result.trip, finalZ: result.finalZ,
          unprocessedDuration: result.unprocessedDuration
        }, null, 2));
        break;
      }
      case "list":
        console.log(JSON.stringify(store.list(), null, 2));
        break;
      case "get": {
        const rec = store.get(args[0] ?? "");
        if (!rec) throw new SimError("RUN_NOT_FOUND", "运行不存在");
        console.log(resultToJSON(parseResult(rec)));
        break;
      }
      case "state": {
        const rec = store.get(args[0] ?? "");
        if (!rec) throw new SimError("RUN_NOT_FOUND", "运行不存在");
        console.log(JSON.stringify(stateAtTime(parseResult(rec), Number(args[1])), null, 2));
        break;
      }
      case "compare": {
        const a = store.get(args[0] ?? "");
        const b = store.get(args[1] ?? "");
        if (!a || !b) throw new SimError("RUN_NOT_FOUND", "指定的运行不存在");
        console.log(JSON.stringify(compareRuns(parseResult(a), parseResult(b)), null, 2));
        break;
      }
      case "export": {
        const rec = store.get(args[0] ?? "");
        if (!rec) throw new SimError("RUN_NOT_FOUND", "运行不存在");
        const result = parseResult(rec);
        const fmt = args[1] === "csv" ? "csv" : "json";
        writeFileSync(resolve(args[2] ?? `result.${fmt}`),
          fmt === "csv" ? segmentsToCSV(result) : resultToJSON(result), "utf8");
        console.log(`已导出 ${fmt}: ${args[2] ?? `result.${fmt}`}`);
        break;
      }
      case "serve": {
        const { createApp, pickFreePort } = await import("../server/index.ts");
        const port = await pickFreePort(Number(args[0] ?? process.env.PORT ?? 0) || 0);
        createApp(store).listen(port, "127.0.0.1", () => {
          console.log(`[idmt-sim] http://127.0.0.1:${port}  数据: ${DB_PATH}`);
        });
        return;
      }
      default:
        console.log(USAGE);
        if (cmd) process.exit(1);
    }
  } catch (err) {
    fail(err);
  } finally {
    if (cmd !== "serve") store.close();
  }
}

void main();

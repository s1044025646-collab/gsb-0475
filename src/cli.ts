/**
 * CLI：serve / run / demo / runs / export / query / compare。
 * 数据默认保存在项目内 data/relay.db（可用 --db 覆盖）。
 */
import { readFileSync } from "node:fs";
import {
  simulate,
  validateConfig,
  validateSegments,
  queryIntraSegment,
  operatingTime,
  SegmentInput,
} from "./engine.js";
import { Store, defaultDbPath } from "./store.js";
import { startServer, resultToCsv } from "./server.js";

function argValue(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? (args[i + 1] as string) : null;
}

function readJsonFile(p: string): unknown {
  return JSON.parse(readFileSync(p, "utf8"));
}

function printJson(v: unknown): void {
  process.stdout.write(JSON.stringify(v, null, 2) + "\n");
}

function openStore(args: string[]): Store {
  return new Store(argValue(args, "--db") ?? defaultDbPath());
}

const USAGE = `用法: node dist/src/cli.js <命令> [选项]

命令:
  serve [--port N] [--db PATH]           启动 HTTP API（默认端口 0 = 自动选空闲端口）
  run <config.json> <segments.json> [--request-key K] [--db PATH]
                                         校验、执行并保存一次仿真
  demo [--db PATH]                       运行内置演示（恒定 2 倍 Ip 三种时长 + 复归场景）
  runs [--db PATH]                       列出已保存的运行
  export <runId> [--format csv|json] [--db PATH]
  query <runId> <segmentId> <offset秒> [--db PATH]   段内只读状态查询
  compare <config.json> <historyA.json> <historyB.json>

config.json:    {"pickupCurrent": 1, "tms": 1, "resetTime": 10}
segments.json:  [{"id":"s1","duration":5,"current":2}, ...]
`;

function runDemo(store: Store): void {
  const cfg = { pickupCurrent: 1, tms: 1, resetTime: 10 };
  const T2 = operatingTime(2, cfg.tms)!;
  process.stdout.write(`配置: Ip=1, TMS=1, Tr=10; T(2)=${T2} s\n\n`);

  const cases: Array<[string, SegmentInput[]]> = [
    ["A: 2*Ip 持续 0.8*T(2)（不跳闸）", [{ id: "a1", duration: 0.8 * T2, current: 2 }]],
    ["B: 2*Ip 持续 1.0*T(2)（恰在段末跳闸）", [{ id: "b1", duration: T2, current: 2 }]],
    ["C: 2*Ip 持续 1.5*T(2)（段内跳闸）", [{ id: "c1", duration: 1.5 * T2, current: 2 }]],
    [
      "D: 2*Ip 0.4*T(2) → 0A 0.2*Tr → 2*Ip 直至跳闸",
      [
        { id: "d1", duration: 0.4 * T2, current: 2 },
        { id: "d2", duration: 0.2 * cfg.resetTime, current: 0 },
        { id: "d3", duration: T2, current: 2 },
      ],
    ],
  ];
  for (const [title, segs] of cases) {
    const r = simulate(cfg, segs);
    process.stdout.write(`== ${title}\n`);
    for (const s of r.segments) {
      process.stdout.write(
        `   [${s.segmentId}] t=[${s.start.toFixed(6)}, ${s.end.toFixed(6)}) M=${s.multiple} ` +
          `${s.mode} z: ${s.progressBefore.toFixed(6)} -> ${s.progressAfter.toFixed(6)}\n`,
      );
    }
    process.stdout.write(
      r.trip
        ? `   跳闸: 段=${r.trip.segmentId} 时刻=${r.trip.tripTime.toFixed(6)}s 段内偏移=${r.trip.offsetInSegment.toFixed(6)}s 未处理后缀=${r.trip.unprocessedSuffix.toFixed(6)}s\n\n`
        : `   未跳闸，最终进度 z=${r.segments.at(-1)?.progressAfter.toFixed(6)}\n\n`,
    );
    const configId = store.saveConfig(cfg);
    const [runId] = store.saveRun(configId, segs, r, "demo", null);
    process.stdout.write(`   已保存为运行 #${runId}\n\n`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === "help" || cmd === "--help") {
    process.stdout.write(USAGE);
    return;
  }

  if (cmd === "serve") {
    const port = Number(argValue(args, "--port") ?? process.env.PORT ?? 0);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error("--port 必须为 0..65535 的整数（0 = 自动选空闲端口）");
    }
    const store = openStore(args);
    const { port: actual } = await startServer(store, port);
    process.stdout.write(`API 已启动: http://127.0.0.1:${actual} （Ctrl+C 停止）\n`);
    return;
  }

  const store = openStore(args);
  try {
    if (cmd === "run") {
      const cfg = validateConfig(readJsonFile(args[1]!));
      const segments = validateSegments(readJsonFile(args[2]!));
      const result = simulate(cfg, segments);
      const configId = store.saveConfig(cfg);
      const [runId, created] = store.saveRun(
        configId, segments, result, "cli", argValue(args, "--request-key"),
      );
      printJson({ runId, created, result });
    } else if (cmd === "demo") {
      runDemo(store);
    } else if (cmd === "runs") {
      printJson(store.listRuns());
    } else if (cmd === "export") {
      const run = store.getRun(Number(args[1]));
      if (!run) throw new Error(`运行 ${args[1]} 不存在`);
      const format = argValue(args, "--format") ?? "json";
      if (format === "csv") process.stdout.write(resultToCsv(run.result));
      else printJson(run.result);
    } else if (cmd === "query") {
      const run = store.getRun(Number(args[1]));
      if (!run) throw new Error(`运行 ${args[1]} 不存在`);
      const seg = run.result.segments.find((s) => s.segmentId === args[2]);
      if (!seg) throw new Error(`运行 ${args[1]} 中不存在段 ${args[2]}`);
      printJson(queryIntraSegment(run.config, seg, Number(args[3])));
    } else if (cmd === "compare") {
      const cfg = validateConfig(readJsonFile(args[1]!));
      const a = simulate(cfg, validateSegments(readJsonFile(args[2]!)));
      const b = simulate(cfg, validateSegments(readJsonFile(args[3]!)));
      printJson({
        a: { trip: a.trip, finalProgress: a.segments.at(-1)?.progressAfter ?? 0 },
        b: { trip: b.trip, finalProgress: b.segments.at(-1)?.progressAfter ?? 0 },
        tripTimeDelta: a.trip && b.trip ? b.trip.tripTime - a.trip.tripTime : null,
      });
    } else {
      process.stderr.write(`未知命令: ${cmd}\n\n${USAGE}`);
      process.exitCode = 2;
    }
  } finally {
    store.close();
  }
}

main().catch((e) => {
  const msg =
    e instanceof Error && "details" in e
      ? JSON.stringify((e as { details: unknown }).details)
      : String(e.message ?? e);
  process.stderr.write(`错误: ${msg}\n`);
  process.exitCode = 1;
});

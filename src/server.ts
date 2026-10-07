/**
 * HTTP API：仅本地回环监听，使用 Node 内置 http，无外部依赖。
 */
import http from "node:http";
import { AddressInfo } from "node:net";
import {
  ValidationError,
  simulate,
  validateConfig,
  validateSegments,
  queryIntraSegment,
  SimulationResult,
} from "./engine.js";
import { Store } from "./store.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function sendError(res: http.ServerResponse, e: unknown): void {
  if (e instanceof ApiError) {
    sendJson(res, e.status, { error: { code: e.code, message: e.message, details: e.details ?? null } });
  } else if (e instanceof ValidationError) {
    sendJson(res, 400, { error: { code: e.code, message: "参数校验失败", details: e.details } });
  } else {
    sendJson(res, 500, { error: { code: "INTERNAL", message: String(e) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 10 * 1024 * 1024) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "请求体超过 10MB");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "BAD_JSON", "请求体不是合法 JSON");
  }
}

export function resultToCsv(result: SimulationResult): string {
  const header =
    "seq,segmentId,start,end,current,multiple,mode,operatingTime,progressBefore,progressAfter,processedDuration,resetToZeroAt";
  const rows = result.segments.map((s) =>
    [
      s.seq, csvCell(s.segmentId), s.start, s.end, s.current, s.multiple, s.mode,
      s.operatingTime ?? "", s.progressBefore, s.progressAfter, s.processedDuration,
      s.resetToZeroAt ?? "",
    ].join(","),
  );
  const trip = result.trip
    ? `\n# trip,segment=${result.trip.segmentId},time=${result.trip.tripTime},offset=${result.trip.offsetInSegment},progressBefore=${result.trip.progressBefore},unprocessedSuffix=${result.trip.unprocessedSuffix}`
    : "\n# trip,none";
  return [header, ...rows].join("\n") + trip + "\n";
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function requireRun(store: Store, id: number) {
  const run = store.getRun(id);
  if (!run) throw new ApiError(404, "NOT_FOUND", `运行 ${id} 不存在`);
  return run;
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      // POST /configs {pickupCurrent,tms,resetTime}
      if (method === "POST" && parts[0] === "configs" && parts.length === 1) {
        const cfg = validateConfig(await readBody(req));
        const id = store.saveConfig(cfg);
        sendJson(res, 201, { configId: id, config: cfg });
        return;
      }

      // POST /runs {configId?, config?, segments, source?, requestKey?}
      // 幂等：requestKey 相同返回已有运行。坏段整体拒绝，不落库。
      if (method === "POST" && parts[0] === "runs" && parts.length === 1) {
        const body = (await readBody(req)) as Record<string, unknown>;
        let cfg;
        let configId: number;
        if (body.config !== undefined) {
          cfg = validateConfig(body.config);
          configId = store.saveConfig(cfg);
        } else if (typeof body.configId === "number") {
          const found = store.getConfig(body.configId);
          if (!found) throw new ApiError(404, "NOT_FOUND", `配置 ${body.configId} 不存在`);
          cfg = found;
          configId = body.configId;
        } else {
          throw new ApiError(400, "VALIDATION_ERROR", "必须提供 config 或 configId");
        }
        const segments = validateSegments(body.segments);
        const requestKey =
          typeof body.requestKey === "string" && body.requestKey.length > 0
            ? body.requestKey
            : null;
        const source = typeof body.source === "string" ? body.source : "api";
        const result = simulate(cfg, segments);
        const [runId, created] = store.saveRun(configId, segments, result, source, requestKey);
        const stored = requireRun(store, runId);
        sendJson(res, created ? 201 : 200, {
          runId, created, algoVersion: stored.algoVersion, result: stored.result,
        });
        return;
      }

      // GET /runs 列表
      if (method === "GET" && parts[0] === "runs" && parts.length === 1) {
        sendJson(res, 200, { runs: store.listRuns() });
        return;
      }

      // GET /runs/:id
      if (method === "GET" && parts[0] === "runs" && parts.length === 2) {
        const run = requireRun(store, Number(parts[1]));
        sendJson(res, 200, {
          runId: run.runId, algoVersion: run.algoVersion, tolerance: run.tolerance,
          source: run.source, createdAt: run.createdAt, inputs: run.inputs, result: run.result,
        });
        return;
      }

      // GET /runs/:id/export?format=csv|json
      if (method === "GET" && parts[0] === "runs" && parts[2] === "export") {
        const run = requireRun(store, Number(parts[1]));
        const format = url.searchParams.get("format") ?? "json";
        if (format === "csv") {
          res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
          res.end(resultToCsv(run.result));
        } else if (format === "json") {
          sendJson(res, 200, run.result);
        } else {
          throw new ApiError(400, "VALIDATION_ERROR", "format 仅支持 csv 或 json");
        }
        return;
      }

      // GET /runs/:id/segments/:segId/state?offset=<秒>
      // 段内只读查询：使用冻结结果与同一公式，不写库。
      if (method === "GET" && parts[0] === "runs" && parts[2] === "segments" && parts[4] === "state") {
        const run = requireRun(store, Number(parts[1]));
        const segId = decodeURIComponent(parts[3] ?? "");
        const seg = run.result.segments.find((s) => s.segmentId === segId);
        if (!seg) throw new ApiError(404, "NOT_FOUND", `运行 ${run.runId} 中不存在段 ${segId}`);
        const offsetRaw = url.searchParams.get("offset");
        const offset = offsetRaw === null ? NaN : Number(offsetRaw);
        const state = queryIntraSegment(run.config, seg, offset);
        sendJson(res, 200, { runId: run.runId, algoVersion: run.algoVersion, state });
        return;
      }

      // POST /compare {config|configId, historyA: [...], historyB: [...]}
      if (method === "POST" && parts[0] === "compare" && parts.length === 1) {
        const body = (await readBody(req)) as Record<string, unknown>;
        let cfg;
        if (body.config !== undefined) {
          cfg = validateConfig(body.config);
        } else if (typeof body.configId === "number") {
          const found = store.getConfig(body.configId);
          if (!found) throw new ApiError(404, "NOT_FOUND", `配置 ${body.configId} 不存在`);
          cfg = found;
        } else {
          throw new ApiError(400, "VALIDATION_ERROR", "必须提供 config 或 configId");
        }
        const a = simulate(cfg, validateSegments(body.historyA));
        const b = simulate(cfg, validateSegments(body.historyB));
        const ta = a.trip?.tripTime ?? null;
        const tb = b.trip?.tripTime ?? null;
        sendJson(res, 200, {
          algoVersion: a.algoVersion,
          a: { trip: a.trip, finalProgress: a.segments.at(-1)?.progressAfter ?? 0 },
          b: { trip: b.trip, finalProgress: b.segments.at(-1)?.progressAfter ?? 0 },
          comparison: {
            bothTripped: ta !== null && tb !== null,
            tripTimeDelta: ta !== null && tb !== null ? tb - ta : null,
            firstToTrip:
              ta === null && tb === null ? "none"
              : ta === null ? "b"
              : tb === null ? "a"
              : ta < tb ? "a" : tb < ta ? "b" : "same",
          },
        });
        return;
      }

      throw new ApiError(404, "NOT_FOUND", `未知路由 ${method} ${url.pathname}`);
    } catch (e) {
      sendError(res, e);
    }
  });
}

/**
 * 启动服务。port=0（默认）时由系统分配空闲端口。
 */
export function startServer(store: Store, port: number, host = "127.0.0.1"): Promise<{ server: http.Server; port: number }> {
  const server = createServer(store);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

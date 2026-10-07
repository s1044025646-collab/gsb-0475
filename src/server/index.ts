import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { Store, parseResult } from "../db/store.ts";
import { SimError } from "../engine/types.ts";
import { compareRuns, stateAtTime } from "../engine/simulate.ts";
import { segmentsToCSV, resultToJSON } from "../engine/export.ts";

const DATA_DIR = process.env.IDMT_DATA_DIR ?? resolve(process.cwd(), "data");
const DB_PATH = process.env.IDMT_DB_PATH ?? resolve(DATA_DIR, "idmt.sqlite");

export async function pickFreePort(preferred = 0): Promise<number> {
  return await new Promise((res, rej) => {
    const srv = createNetServer();
    srv.on("error", rej);
    srv.listen(preferred, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => res(port));
      } else {
        srv.close(() => rej(new Error("无法获取空闲端口")));
      }
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" && body.startsWith("#") ? "text/csv; charset=utf-8"
      : "application/json; charset=utf-8"
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new SimError("JSON_INVALID", "请求体不是合法 JSON");
  }
}

export function createApp(store: Store) {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const parts = path.split("/").filter(Boolean);
    void (async () => {
      try {
        if (req.method === "GET" && path === "/health") {
          return send(res, 200, { ok: true, service: "idmt-overcurrent-sim" });
        }
        if (req.method === "POST" && path === "/api/validate") {
          const body = (await readJson(req)) as { config?: unknown; segments?: unknown };
          const { validateConfig, validateSegments } = await import("../engine/validate.ts");
          const out: Record<string, unknown> = { valid: true };
          if (body.config !== undefined) out.config = validateConfig(body.config);
          if (body.segments !== undefined) out.segments = validateSegments(body.segments);
          return send(res, 200, out);
        }
        if (req.method === "POST" && path === "/api/simulate") {
          const body = (await readJson(req)) as
            { config?: unknown; segments?: unknown; runId?: string; name?: string };
          const rec = store.run(body.config, body.segments, {
            runId: body.runId, name: body.name, source: "api"
          });
          return send(res, rec.reused ? 200 : 201, {
            runId: rec.runId, reused: rec.reused, createdAt: rec.createdAt,
            algoVersion: rec.algoVersion, toleranceVersion: rec.toleranceVersion,
            result: parseResult(rec)
          });
        }
        if (req.method === "GET" && path === "/api/runs") {
          return send(res, 200, { runs: store.list() });
        }
        const runMatch = parts[0] === "api" && parts[1] === "runs" && parts[2];
        if (runMatch && parts.length === 3 && req.method === "GET") {
          const rec = store.get(runMatch);
          if (!rec) return send(res, 404, { error: { code: "RUN_NOT_FOUND", message: "运行不存在" } });
          return send(res, 200, { runId: rec.runId, result: parseResult(rec) });
        }
        if (runMatch && parts[3] === "state" && req.method === "GET") {
          const rec = store.get(runMatch);
          if (!rec) return send(res, 404, { error: { code: "RUN_NOT_FOUND", message: "运行不存在" } });
          const t = Number(url.searchParams.get("time") ?? "");
          return send(res, 200, { state: stateAtTime(parseResult(rec), t) });
        }
        if (runMatch && parts[3] === "export" && req.method === "GET") {
          const rec = store.get(runMatch);
          if (!rec) return send(res, 404, { error: { code: "RUN_NOT_FOUND", message: "运行不存在" } });
          const result = parseResult(rec);
          const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
          res.setHeader("content-disposition",
            `attachment; filename="${runMatch}.${format}"`);
          return send(res, 200, format === "csv" ? segmentsToCSV(result) : resultToJSON(result));
        }
        if (req.method === "POST" && path === "/api/runs/compare") {
          const body = (await readJson(req)) as { runIdA?: string; runIdB?: string };
          const a = body.runIdA ? store.get(body.runIdA) : null;
          const b = body.runIdB ? store.get(body.runIdB) : null;
          if (!a || !b) {
            return send(res, 404, { error: { code: "RUN_NOT_FOUND", message: "指定的运行不存在" } });
          }
          return send(res, 200, { comparison: compareRuns(parseResult(a), parseResult(b)) });
        }
        return send(res, 404, { error: { code: "NOT_FOUND", message: "未知路由" } });
      } catch (err) {
        if (err instanceof SimError) {
          return send(res, 400, { error: { code: err.code, message: err.message, details: err.details ?? null } });
        }
        const e = err as Error & { code?: string };
        if (e.code === "RUN_ID_EXISTS") {
          return send(res, 409, { error: { code: e.code, message: e.message } });
        }
        return send(res, 500, { error: { code: "INTERNAL", message: e.message } });
      }
    })();
  });
}

const entry = process.argv[1] ? (isAbsolute(process.argv[1])
  ? pathToFileURL(process.argv[1]).href
  : pathToFileURL(resolve(process.cwd(), process.argv[1])).href) : "";
if (import.meta.url === entry) {
  const preferred = Number(process.env.PORT ?? process.argv[2] ?? 0) || 0;
  const port = await pickFreePort(preferred);
  const store = new Store(DB_PATH);
  const server = createApp(store);
  server.listen(port, "127.0.0.1", () => {
    console.log(`[idmt-sim] 数据文件: ${DB_PATH}`);
    console.log(`[idmt-sim] 监听 http://127.0.0.1:${port}`);
  });
  const shutdown = () => { store.close(); server.close(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

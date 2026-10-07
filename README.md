# 反时限过流动作积分与区间内跳闸时刻仿真后端

教学用**单相反时限过流继电器离线仿真**服务。输入一组连续的恒定电流时段，
按动作时间积分累计跳闸进度，并给出**段内精确跳闸时刻**。仅提供 HTTP API 与 CLI，
纯后端，Windows 本地运行，不依赖 Docker / WSL / 外部在线服务。

## 模型范围（理想化教学模型）

- 只处理给定的 RMS 电流与逻辑时间（秒）；**不**读取真实电网、**不**控制开关。
- **不**做潮流、短路电流计算、热网络或保护配合优化。
- 电流与起动电流 Ip 使用相同单位；时间统一为秒。

## 动作与复归模型

令倍数 `M = I / Ip`：

- **M > 1（动作）**：标准反时限曲线
  `T(M) = 0.14 * TMS / (M^0.02 - 1)`，进度按 `dz/dt = 1/T(M)` 增长。
  实现上用 `expm1(0.02 * ln M)` 计算分母，避免 M≈1 时幂减一的数值消去。
- **M <= 1（复归，含恰等于起动电流）**：不代入动作公式，进度按
  `dz/dt = -1/Tr` **线性**下降，下限为 0。复归按当前绝对进度 z 降低，
  不是百分比指数衰减，也不会电流一低于门槛就无条件清零。
- 状态只有未跳闸进度 `z`（初值 0）与锁存的跳闸信息。不同过流时段共享已积累的 z，
  不为每段重新计时。
- **段内跳闸**：过流段开始于 t0、进度 z0 时，尚需 `(1 - z0) * T(M)` 秒；
  若不超过本段时长，跳闸时刻为 `t0 + 该值`，z 锁存为 1。恰在段末达到 1 仍算
  本段触发。跳闸后后续段不再积分、不复归、不解锁（输出中标记为 `latched`，
  实际处理时长为 0），并报告触发段未处理的后缀时长。
- 重新实验请创建新运行；本系统不提供运行内手动复归命令。

## 环境与命令

要求 Node.js ≥ 22.5（使用内置 `node:sqlite`，无原生编译依赖）。

```powershell
npm install     # 安装 TypeScript 等开发依赖
npm run build   # 编译到 dist/
npm test        # 构建并运行全部测试
npm start       # 启动 API（默认端口 0 = 自动选空闲端口，PORT 环境变量或 --port 指定）
npm run demo    # 内置演示：恒定 2 倍 Ip 三种时长 + 复归场景
```

CLI（`node dist/src/cli.js <命令>`，数据默认存于项目内 `data/relay.db`）：

```
serve [--port N] [--db PATH]                 启动 HTTP API
run <config.json> <segments.json> [--request-key K]
demo / runs / export <runId> [--format csv|json]
query <runId> <segmentId> <offset秒>          段内只读状态查询
compare <config.json> <historyA.json> <historyB.json>
```

`config.json`：`{"pickupCurrent": 1, "tms": 1, "resetTime": 10}`
`segments.json`：`[{"id":"s1","duration":5,"current":2}, ...]`（id 唯一、
duration 正有限、current 非负有限；输入顺序即时间顺序，从 0 累计边界，
不支持重叠或间隙）。

## HTTP API

默认监听 `127.0.0.1`，端口 0 表示自动选空闲端口。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/configs` | 保存配置，返回 `configId` |
| POST | `/runs` | 校验 + 执行 + 冻结保存一次仿真；`requestKey` 幂等 |
| GET | `/runs` / `/runs/:id` | 列出 / 查询运行（含原始输入与冻结结果） |
| GET | `/runs/:id/export?format=csv\|json` | 导出结果 |
| GET | `/runs/:id/segments/:segId/state?offset=秒` | 段内只读查询（同一公式，不改结果；跳闸后返回锁存状态） |
| POST | `/compare` | 同一配置比较两份电流历程的跳闸时刻与最终进度 |

错误统一为 `{"error":{"code","message","details"}}`，错误码：
`VALIDATION_ERROR`（400，含逐条原因）、`BAD_JSON`、`PAYLOAD_TOO_LARGE`、
`NOT_FOUND`（404）、`INTERNAL`（500）。坏段整体拒绝，不会部分写入。

## 持久化与可核对性

SQLite（`data/relay.db`）保存：配置、原始段序列、算法版本
（`iec-standard-inverse-v1`）与容差（1e-12）、冻结的每段结果与跳闸信息、
来源（api/cli/demo）。服务重启后可通过 `GET /runs/:id` 核对原跳闸时刻。
相同 `requestKey` 的重复请求返回已有运行，不重复写入。

## 输出字段（每段）

`start/end`（起止时刻）、`multiple`（M）、`mode`（operate/reset/latched）、
`operatingTime`（完整动作时间 T(M)，不适用为 null）、`progressBefore/After`、
`processedDuration`（实际参与积分时长）、`resetToZeroAt`（复归段内清零时刻）。
跳闸信息：`segmentId`、`offsetInSegment`、`tripTime`、`progressBefore`、
`unprocessedSuffix`。

## 已知限制

- 单相继电器、理想阶跃电流；段内电流恒定。
- `node:sqlite` 在 Node 25 仍标记为实验特性（会打印一条警告），接口未来可能微调。
- 未实现运行内手动复归、多段曲线（如非常反时限）与谐波/温度效应。

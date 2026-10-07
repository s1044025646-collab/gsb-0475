# 反时限过流动作积分与区间内跳闸时刻仿真（后端）

教学用**单相**反时限（IDMT）过流继电器**离线仿真服务**。输入一组按时间顺序排列的恒定 RMS 电流时段，
累计动作进度 `z`，在过流时段**内部**求交点确定确切跳闸时刻；跳闸后进度锁存为 1，不自动复归。

仅处理给定 RMS 电流与逻辑时间：**不**读取真实电网、**不**控制开关、**不**做潮流/短路电流计算、
热网络建模或保护配合优化。只提供 HTTP API 与 CLI，无前端、无鉴权、无外部在线依赖。

## 模型与公式

配置（均为正数）：

- `Ip`：起动电流（pickup，电流与之同单位）
- `TMS`：时间倍率
- `Tr`：复归时间（秒）

令倍数 `M = I / Ip`。

**动作（M > 1）**，标准反时限（IEC 正常反时限常数 0.14）完整动作时间：

```
T(M) = 0.14 * TMS / (M^0.02 - 1)
dz/dt = 1 / T(M)
```

近 `M=1` 时分母用 `expm1(0.02·ln M)` 计算，避免直接做幂减一的浮点消去；
`M <= 1` **不**代入公式（不存在负动作时间或无穷大），并对参数幅值设限、对中间结果做有限性检查。

**复归（M <= 1，含恰等于起动电流）**：

```
dz/dt = -1 / Tr,   z 最低为 0（线性绝对复归，非百分比指数衰减）
```

电流降到门槛不会无条件清零；复归段会记录进度实际到达零的绝对时刻，其余时间保持零。

**跳闸判定（段内交点，而非段末才检查）**：过流段开始于 `t0`、段前进度 `z0`，
尚需时间 `(1 - z0)·T(M)`。若该值不大于本段时长，则跳闸时刻

```
t_trip = t0 + (1 - z0)·T(M)
```

`z` 锁存为 1；之后所有电流段不再积分、不自动解锁，报告触发段、段内位置、动作前进度与
**未处理后缀时长**（不会悄悄丢弃剩余输入却声称全部执行）。恰在段末达到 1 仍算该段触发，
下一段低电流不能“复归救回”。想重跑实验请新建运行；本项目**不**提供运行内手动复归命令。

分段边界从 0 连续累计，不支持重叠或隐含间隙；段 ID 必须唯一。

手算核验（分段线性）：`T(2) ≈ 10.029027 s`（TMS=1）。例如 2Ip 持续 `0.4·T(2)` → `z=0.4`；
零电流持续 `0.2·Tr` → `z=0.2`；再过流只需 `0.8·T(2)` 即跳闸，而非完整一次动作时间。

## 理想模型范围与假设

- 每段内电流恒定、瞬时切换，不建模波形、谐波、直流偏移、互感器与断路器动作时间。
- 时间均为逻辑秒；无温度、无热记忆，除 `z` 外无其它状态。
- 进度仅在 `[0,1]`；跳闸是锁存事件。重复实验 = 新建运行。
- 数值容差版本 `abs1e-12-rel1e-12/v1`，算法版本 `IEC-NI-0.14/v1`，随结果一起冻结入库。

## 环境要求

- Windows 本地运行；Node.js **>= 22.5**（开发实测 v25.5.0），使用内置
  `node:sqlite`（实验性，仅启动警告）与 TS 类型擦除，**无需** Docker/WSL/付费服务/外部 API。

## 构建 / 测试 / 启动 / 演示

```powershell
npm install        # 仅安装 typescript / @types/node 开发依赖
npm run build      # tsc 编译到 dist/
npm test           # node:test，18 个用例
npm run demo       # 直接打印题目全部教学场景的手算级结果
npm start          # HTTP 服务；默认自动选择空闲端口
```

也可用编译产物：`node dist/cli/index.js ...`、`node dist/server/index.js [port]`。

## 数据目录与端口

- 默认 SQLite 文件：项目内 `data/idmt.sqlite`（自动创建）。
  可用环境变量 `IDMT_DATA_DIR` 或 `IDMT_DB_PATH` 覆盖。
- 端口：`npm start` 自动选空闲端口；`PORT=8080 npm start` 或传位置参数 `node ... 8080` 指定。

## CLI

```powershell
node --experimental-strip-types src/cli/index.ts validate input.json
node --experimental-strip-types src/cli/index.ts run input.json [--name N] [--run-id ID] [--out r.json]
node --experimental-strip-types src/cli/index.ts list
node --experimental-strip-types src/cli/index.ts get <runId>
node --experimental-strip-types src/cli/index.ts state <runId> <time>
node --experimental-strip-types src/cli/index.ts compare <runIdA> <runIdB>
node --experimental-strip-types src/cli/index.ts export <runId> <csv|json> <outFile>
node --experimental-strip-types src/cli/index.ts serve [port]
```

`input.json`：

```json
{
  "name": "可选名称",
  "config": { "ip": 100, "tms": 1, "tr": 5 },
  "segments": [
    { "id": "s1", "duration": 12.0, "current": 200 }
  ]
}
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/api/validate` | 只校验配置/段，不落库 |
| POST | `/api/simulate` | 校验+执行+冻结入库（幂等，见下） |
| GET | `/api/runs` | 运行列表 |
| GET | `/api/runs/:id` | 取冻结结果 |
| GET | `/api/runs/:id/state?time=t` | 只读段内状态（同一冻结公式，跳闸后返回锁存） |
| GET | `/api/runs/:id/export?format=csv\|json` | 导出 CSV/JSON |
| POST | `/api/runs/compare` | 比较两份历程：跳闸时刻、最终进度、`maxAbsZDiff` |

`POST /api/simulate` 请求体：`{ config, segments, runId?, name? }`。

**幂等**：相同规范化配置 + 段序列（连同算法/容差版本）哈希一致时直接返回已冻结结果（HTTP 200，
`reused:true`），不重复写入；新输入返回 201。坏输入在校验阶段整体拒绝（HTTP 400），
**不会部分写入**。重启后可用 `get` 核对原跳闸时刻（结果 JSON 连同来源、版本整存）。

错误码（JSON `error.code`）：`CONFIG_INVALID`、`CONFIG_OUT_OF_RANGE`、`SEGMENTS_INVALID`、
`SEGMENTS_EMPTY`、`SEGMENTS_TOO_MANY`、`SEGMENT_ID_INVALID/DUPLICATE/TOO_LONG`、
`SEGMENT_DURATION_INVALID`、`SEGMENT_CURRENT_INVALID`、`M_NOT_ABOVE_PICKUP`、
`M_OUT_OF_RANGE`、`NUMERIC_NONFINITE`、`JSON_INVALID`、`RUN_NOT_FOUND`、
`RUN_ID_EXISTS`、`QUERY_TIME_INVALID`、`NOT_FOUND`、`INTERNAL`。

快速试一下：

```powershell
curl.exe -s http://127.0.0.1:<端口>/health
curl.exe -s -X POST http://127.0.0.1:<端口>/api/simulate -H "content-type: application/json" `
  -d '{\"config\":{\"ip\":100,\"tms\":1,\"tr\":5},\"segments\":[{\"id\":\"a\",\"duration\":20,\"current\":200}]}'
```

## 输出字段

每段输出：起止时间、`M`、模式 `OPERATE/RESET`、完整动作时间（复归段为 `null`）、
段前/段后进度、实际处理时长、未处理后缀时长、以及复归到零的绝对时刻（不适用为 `null`）。
顶层另含：是否跳闸、触发段/段内位置/绝对跳闸时刻/动作前进度、最终进度、总时长、
已处理与未处理时长、算法与容差版本。

## 目录结构

```
src/
  engine/  曲线(curve)、校验(validate)、仿真与段内查询(simulate)、导出(export)、测试
  db/      SQLite 持久层(store)
  server/  原生 node:http API
  cli/     命令行与教学演示(demo)
data/      运行期生成（git 忽略）
```

import { simulate, stateAtTime } from "../engine/simulate.ts";
import { operateTime } from "../engine/curve.ts";
import type { RawSegment } from "../engine/types.ts";

const config = { ip: 100, tms: 1, tr: 5 };
const T = operateTime(2, 1);
const s = (id: string, duration: number, current: number): RawSegment => ({ id, duration, current });

function line(...parts: unknown[]): void { console.log(...parts); }
line("================ 反时限过流仿真演示 ================");
line(`Ip=${config.ip}A  TMS=${config.tms}  Tr=${config.tr}s`);
line(`标准曲线 T(M)=0.14*TMS/(M^0.02-1)，T(2)=${T.toFixed(6)}s`);
line("");

function show(title: string, r: ReturnType<typeof simulate>): void {
  line(`---- ${title} ----`);
  for (const seg of r.segments) {
    line(`[${seg.id}] t=[${seg.start.toFixed(4)}, ${seg.end.toFixed(4)}] I=${seg.current} ` +
      `M=${seg.m.toFixed(3)} ${seg.mode} T(M)=${seg.fullOperateTime?.toFixed(4) ?? "NA"} ` +
      `z:${seg.zBefore.toFixed(4)}->${seg.zAfter.toFixed(4)} ` +
      `处理${seg.processedDuration.toFixed(4)}s 后缀未处理${seg.unprocessedSuffix.toFixed(4)}s` +
      (seg.zeroResetAt !== null ? ` 于 t=${seg.zeroResetAt.toFixed(4)} 清零` : ""));
  }
  if (r.trip) {
    line(`>> 跳闸：段 ${r.trip.segmentId}，段内 ${r.trip.offsetInSegment.toFixed(6)}s，` +
      `绝对时刻 t=${r.trip.tripTime.toFixed(6)}s，动作前 z=${r.trip.zBefore.toFixed(4)}`);
  } else {
    line(`>> 未跳闸，最终 z=${r.finalZ.toFixed(4)}`);
  }
  line(`总时长 ${r.totalDuration.toFixed(4)}s，已处理 ${r.processedDuration.toFixed(4)}s，` +
    `未处理后缀 ${r.unprocessedDuration.toFixed(4)}s`);
  line("");
}

show("场景1：2Ip 持续 0.5*T(2)（不跳闸）", simulate(config, [s("s1", 0.5 * T, 200)]));
show("场景2：2Ip 持续 恰 T(2)（段末跳闸，时刻 T(2)）", simulate(config, [s("s1", T, 200)]));
show("场景3：2Ip 持续 2*T(2)（段内跳闸，时刻仍 T(2)）", simulate(config, [s("s1", 2 * T, 200)]));

const acc = simulate(config, [
  s("a", 0.4 * T, 200),
  s("b", 0.2 * config.tr, 0),
  s("c", T, 200)
]);
show("场景4：0.4T 动作 -> 0.2Tr 复归(z 0.4->0.2) -> 再过流仅需 0.8T", acc);

const split1 = simulate(config, [s("a", 2 * T, 200)]);
const split2 = simulate(config, [
  s("a", 0.37 * T, 200), s("b", 0.63 * T, 200), s("c", T, 200)
]);
line(`---- 拆分不变性 ----`);
line(`单段跳闸 t=${split1.trip!.tripTime.toFixed(6)}；拆分后跳闸 t=${split2.trip!.tripTime.toFixed(6)}`);
line(`差 = ${Math.abs(split1.trip!.tripTime - split2.trip!.tripTime).toExponential(2)}`);
line("");

const r = simulate(config, [s("a", T, 200), s("b", 100, 0), s("c", 5, 300)]);
line("---- 锁存演示：跳闸后低/高电流均不解锁 ----");
line(`跳闸 t=${r.trip!.tripTime.toFixed(4)}；之后查询 t=50 ->`, JSON.stringify(stateAtTime(r, 50)));
line("");
line(`算法版本 ${acc.algoVersion}，容差版本 ${acc.toleranceVersion}`);

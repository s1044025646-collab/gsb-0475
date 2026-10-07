import { operateTime } from "./curve.ts";

export function T2(tms: number): number {
  return operateTime(2, tms);
}

export const demoConfig = { ip: 100, tms: 1, tr: 5 };

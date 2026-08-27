import type { AutomationRun } from "@lume/shared";

/**
 * runs.jsonl 落盘失败的 run 的内存影子记录（上限 50 条，淘汰最旧）：
 * 历史区可见"确实跑过但未保存"，避免用户面对"任务明明跑了但历史没有"的静默缺口。
 * 仅驻留进程内存，重启后消失——UI 有对应预告（#615 UX review round7）。
 */
const lostRuns: AutomationRun[] = [];

export const MAX_LOST_RUNS = 50;

export function recordLostAutomationRun(run: AutomationRun): void {
  lostRuns.push({ ...run, persistenceLost: true });
  if (lostRuns.length > MAX_LOST_RUNS) lostRuns.shift();
}

export function getLostAutomationRuns(): readonly AutomationRun[] {
  return lostRuns;
}

export function clearLostAutomationRunsForTests(): void {
  lostRuns.length = 0;
}

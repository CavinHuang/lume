import { describe, expect, test } from "bun:test";
import { planTakeover } from "./single-instance";

/**
 * 单例接管决策：新 sidecar 启动时，只在「pidfile 里的旧 PID 仍存活 且 命令行确属 sidecar」
 * 时才杀旧接管。PID 已死 / 是自己 / PID 被其它进程复用 —— 都不杀，仅写入自己的 PID。
 */
describe("planTakeover", () => {
  const currentPid = 100;
  const alive = (pids: number[]) => (pid: number) => pids.includes(pid);
  const sidecar = (pids: number[]) => (pid: number) => pids.includes(pid);

  test("无 pidfile：直接写入自己", () => {
    expect(planTakeover({ pidfileContent: null, currentPid, isAlive: () => false, isSidecar: () => false }))
      .toEqual({ writePid: 100 });
  });

  test("旧 PID 已死：不杀，写入自己", () => {
    expect(planTakeover({ pidfileContent: "999", currentPid, isAlive: alive([]), isSidecar: () => true }))
      .toEqual({ writePid: 100 });
  });

  test("pidfile 是自己：不自杀，写入自己", () => {
    expect(planTakeover({ pidfileContent: "100", currentPid, isAlive: alive([100]), isSidecar: sidecar([100]) }))
      .toEqual({ writePid: 100 });
  });

  test("旧 PID 存活但不是 sidecar（PID 复用）：不杀，写入自己", () => {
    expect(planTakeover({ pidfileContent: "999", currentPid, isAlive: alive([999]), isSidecar: sidecar([]) }))
      .toEqual({ writePid: 100 });
  });

  test("旧 PID 存活且是 sidecar：杀旧接管", () => {
    expect(planTakeover({ pidfileContent: "999", currentPid, isAlive: alive([999]), isSidecar: sidecar([999]) }))
      .toEqual({ killPid: 999, writePid: 100 });
  });

  test("pidfile 内容非数字：忽略，写入自己", () => {
    expect(planTakeover({ pidfileContent: "garbage", currentPid, isAlive: () => true, isSidecar: () => true }))
      .toEqual({ writePid: 100 });
  });
});

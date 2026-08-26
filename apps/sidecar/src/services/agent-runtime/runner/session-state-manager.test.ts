import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getSessionStateManager } from "./session-state-manager";
import { getSessionStatesPath } from "../../infra/config-paths";

// #615② 回归钉死:清理/删除结果必须落盘——否则每次重启全量读回历史条目
// 再"清理"一遍,磁盘文件随历史会话数单调增长永不收敛。
// 注意:单例在首次 import 时构造并 loadFromDisk,bun test 同进程多文件共享
// 模块与 LUME_CONFIG_DIR,故断言全部基于运行时注入的条目与当前路径解析,
// 不依赖夹具文件预写。

describe("session-state-manager 持久化对称 (#615②)", () => {
  test("cleanupExpired 移除过期条目且落盘收敛", () => {
    const manager = getSessionStateManager();
    const expiring = manager.getOrCreate(`ssm-stale-${Date.now()}-${Math.random()}`);
    expiring.updatedAt = Date.now() - 25 * 60 * 60 * 1000;
    const fresh = manager.getOrCreate(`ssm-fresh-${Date.now()}-${Math.random()}`);

    expect(manager.cleanupExpired()).toBeGreaterThanOrEqual(1);
    expect(manager.getAll().includes(expiring)).toBe(false);
    expect(manager.getAll().includes(fresh)).toBe(true);

    const persisted = JSON.parse(readFileSync(getSessionStatesPath(), "utf-8")) as Record<string, { sessionId: string }>;
    expect(Object.values(persisted).some((state) => state.sessionId === expiring.sessionId)).toBe(false);
    expect(Object.values(persisted).some((state) => state.sessionId === fresh.sessionId)).toBe(true);
  });

  test("delete 同步落盘,文件不再残留已删条目", () => {
    const manager = getSessionStateManager();
    const doomed = manager.getOrCreate(`ssm-doomed-${Date.now()}-${Math.random()}`);

    manager.delete(doomed.sessionId);

    expect(manager.getAll().some((state) => state.sessionId === doomed.sessionId)).toBe(false);
    const persisted = JSON.parse(readFileSync(getSessionStatesPath(), "utf-8")) as Record<string, { sessionId: string }>;
    expect(Object.values(persisted).some((state) => state.sessionId === doomed.sessionId)).toBe(false);
  });
});

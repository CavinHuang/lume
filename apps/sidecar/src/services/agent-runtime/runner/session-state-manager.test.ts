import { describe, expect, test } from "bun:test";
import { pruneExpiredSessionStates } from "./session-state-manager";

// 单例在模块加载时读盘且受 preload 时序影响，因此只测纯判定逻辑；
// cleanupExpired 的"cleaned>0 时落盘"由类内实现保证（回滚实验背书，#615）。
describe("pruneExpiredSessionStates（#615）", () => {
  const now = 1_000_000_000_000;
  const makeState = (updatedAt: number) => ({
    sessionId: "s",
    totalTokens: 0,
    contextWindow: 200000,
    compactionCount: 0,
    createdAt: updatedAt,
    updatedAt
  });

  test("过期条目被剔除并计数，新鲜条目保留", () => {
    const states = {
      expired: makeState(now - 25 * 3_600_000),
      fresh: makeState(now - 1 * 3_600_000)
    };
    const { next, cleaned } = pruneExpiredSessionStates(states, now);
    expect(cleaned).toBe(1);
    expect(next.expired).toBeUndefined();
    expect(next.fresh).toBeDefined();
  });

  test("恰好等于 maxAge 不剔除（严格大于判定）", () => {
    const boundary = now - 24 * 3_600_000;
    const { next, cleaned } = pruneExpiredSessionStates({ boundary: makeState(boundary) }, now);
    expect(cleaned).toBe(0);
    expect(next.boundary).toBeDefined();
  });
});

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

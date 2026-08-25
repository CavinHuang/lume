import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 单例在模块加载时读取 LUME_CONFIG_DIR 下的 session-states.json，
// 因此必须先写好预置状态再动态 import（#615：清理结果必须落盘）。
describe("session-state-manager 清理落盘（#615）", () => {
  test("cleanupExpired 后磁盘文件同步收敛，过期条目消失", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-session-state-"));
    process.env.LUME_CONFIG_DIR = configDir;
    const now = Date.now();
    const states = {
      "expired-1": {
        sessionId: "expired-1",
        totalTokens: 1,
        contextWindow: 200000,
        compactionCount: 0,
        createdAt: now - 25 * 3_600_000,
        updatedAt: now - 25 * 3_600_000
      },
      "fresh-1": {
        sessionId: "fresh-1",
        totalTokens: 2,
        contextWindow: 200000,
        compactionCount: 0,
        createdAt: now,
        updatedAt: now
      }
    };
    writeFileSync(join(configDir, "session-states.json"), JSON.stringify(states));

    const { getSessionStateManager } = await import("./session-state-manager");
    const manager = getSessionStateManager();
    const cleaned = manager.cleanupExpired();
    expect(cleaned).toBeGreaterThanOrEqual(1);

    const onDisk = JSON.parse(readFileSync(join(configDir, "session-states.json"), "utf-8")) as Record<string, unknown>;
    expect(onDisk["expired-1"]).toBeUndefined();
    expect(onDisk["fresh-1"]).toBeDefined();
  });
});

import { describe, expect, test } from "bun:test";
import {
  assertCompactSmokeOutcome,
  buildLongCompactionSeedMessages
} from "./agent-runtime-compact-smoke";

describe("agent-runtime-compact-smoke helpers", () => {
  test("buildLongCompactionSeedMessages 应生成稳定的长会话种子消息", () => {
    const messages = buildLongCompactionSeedMessages({
      turnCount: 3,
      marker: "compact-marker"
    });

    expect(messages).toHaveLength(3);
    expect(messages[0]).toContain("compact-marker");
    expect(messages[1]).toContain("第 2 轮");
    expect(messages[2].length).toBeGreaterThan(80);
  });

  test("assertCompactSmokeOutcome 应校验多轮恢复与 compaction 持久化", () => {
    expect(() =>
      assertCompactSmokeOutcome({
        restoredMessages: [
          { role: "assistant", content: "smoke-new-runtime-compact" },
          { role: "user", content: "/compact" }
        ],
        compactEvents: [{ type: "compacting" }, { type: "compact_complete" }],
        persistedJsonlContents: [
          '{"type":"compaction","summary":"smoke compaction summary"}'
        ],
        completedSeedTurns: 3,
        compactionSummary: "smoke compaction summary"
      })
    ).not.toThrow();
  });
});

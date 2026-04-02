import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@lume/shared";
import { buildMinimapItems } from "./ScrollMinimap";

describe("ScrollMinimap", () => {
  test("buildMinimapItems 应只保留 user/assistant 消息", () => {
    const messages: AgentMessage[] = [
      { id: "u1", role: "user", content: "用户消息", createdAt: 1 },
      { id: "s1", role: "status", content: "状态消息", createdAt: 2 },
      { id: "a1", role: "assistant", content: "助手回复", createdAt: 3 },
      { id: "t1", role: "tool", content: "工具输出", createdAt: 4 }
    ];

    expect(buildMinimapItems(messages).map((item) => item.id)).toEqual(["u1", "a1"]);
  });

  test("buildMinimapItems 应截断过长消息", () => {
    const messages: AgentMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "12345678901234567890123456789012345678901234567890",
        createdAt: 1
      }
    ];

    expect(buildMinimapItems(messages)[0]?.label).toBe("1234567890123456789012345678901234567890…");
    expect(buildMinimapItems(messages)[0]?.preview).toBe("12345678901234567890123456789012345678901234567890");
  });
});

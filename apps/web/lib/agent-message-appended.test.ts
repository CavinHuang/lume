import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@lume/shared";
import { appendPersistedAgentMessage } from "./agent-message-appended";

describe("agent-message-appended", () => {
  test("应按 createdAt 追加新消息", () => {
    const existing: AgentMessage[] = [
      { id: "m1", role: "user", content: "u1", createdAt: 100 },
      { id: "m2", role: "assistant", content: "a1", createdAt: 200 }
    ];
    const next: AgentMessage = { id: "m3", role: "assistant", content: "a2", createdAt: 300 };

    expect(appendPersistedAgentMessage(existing, next).map((message) => message.id)).toEqual(["m1", "m2", "m3"]);
  });

  test("重复 id 时应替换而不是重复追加", () => {
    const existing: AgentMessage[] = [
      { id: "m1", role: "assistant", content: "old", createdAt: 100 }
    ];
    const next: AgentMessage = { id: "m1", role: "assistant", content: "new", createdAt: 100 };

    const merged = appendPersistedAgentMessage(existing, next);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.content).toBe("new");
  });
});

import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@lume/shared";
import { trimMessagesFromTarget } from "./agent-message-trim";

describe("agent-use-composer", () => {
  test("trimMessagesFromTarget 应裁掉目标消息及其后续消息", () => {
    const messages: AgentMessage[] = [
      { id: "m1", role: "user", content: "1", createdAt: 1 },
      { id: "m2", role: "assistant", content: "2", createdAt: 2 },
      { id: "m3", role: "user", content: "3", createdAt: 3 }
    ];

    expect(trimMessagesFromTarget(messages, "m3").map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(trimMessagesFromTarget(messages, "m2").map((message) => message.id)).toEqual(["m1"]);
    expect(trimMessagesFromTarget(messages, "missing").map((message) => message.id)).toEqual(["m1", "m2", "m3"]);
  });
});

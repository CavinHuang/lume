import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@lume/shared";
import { getGroupId, groupIntoTurns } from "./SDKMessageRenderer";

describe("SDKMessageRenderer", () => {
  test("groupIntoTurns 应合并被 tool_result 分隔的同模型 assistant turn", () => {
    const messages: SDKMessage[] = [
      {
        type: "assistant",
        uuid: "assistant-1",
        message: {
          role: "assistant",
          model: "claude-sonnet-4",
          content: [{
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { path: "README.md" }
          }]
        }
      } as SDKMessage,
      {
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "ok"
          }]
        }
      } as SDKMessage,
      {
        type: "assistant",
        uuid: "assistant-2",
        message: {
          role: "assistant",
          model: "claude-sonnet-4",
          content: [{
            type: "text",
            text: "done"
          }]
        }
      } as SDKMessage
    ];

    const groups = groupIntoTurns(messages);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.type).toBe("assistant-turn");
    if (groups[0]?.type !== "assistant-turn") {
      throw new Error("expected assistant turn");
    }
    expect(groups[0].assistantMessages).toHaveLength(2);
    expect(groups[0].turnMessages).toHaveLength(3);
  });

  test("getGroupId 对同一 group 对象应返回稳定 fallback id", () => {
    const groups = groupIntoTurns([{
      type: "assistant",
      message: {
        role: "assistant",
        content: [{
          type: "text",
          text: "hello"
        }]
      }
    } satisfies SDKMessage]);

    expect(groups).toHaveLength(1);
    const firstId = getGroupId(groups[0]!);
    const secondId = getGroupId(groups[0]!);

    expect(firstId).toBe(secondId);
    expect(firstId.startsWith("turn-")).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@lume/shared";
import { getGroupId, getGroupPreview, groupIntoTurns } from "./SDKMessageRenderer";

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

  test("groupIntoTurns 应将 compacting 与 compact_boundary 作为独立 system group", () => {
    const messages: SDKMessage[] = [
      {
        type: "assistant",
        uuid: "assistant-before",
        message: {
          role: "assistant",
          model: "claude-sonnet-4",
          content: [{ type: "text", text: "before compact" }]
        }
      } as SDKMessage,
      {
        type: "system",
        subtype: "compacting",
      } as unknown as SDKMessage,
      {
        type: "system",
        subtype: "compact_boundary",
      } as SDKMessage,
      {
        type: "assistant",
        uuid: "assistant-after",
        message: {
          role: "assistant",
          model: "claude-sonnet-4",
          content: [{ type: "text", text: "after compact" }]
        }
      } as SDKMessage
    ];

    const groups = groupIntoTurns(messages);

    expect(groups.map((group) => group.type === "assistant-turn" ? "assistant-turn" : group.type)).toEqual([
      "assistant-turn",
      "system",
      "system"
    ]);
    if (groups[1]?.type !== "system" || groups[2]?.type !== "system" || groups[0]?.type !== "assistant-turn") {
      throw new Error("expected system groups");
    }
    expect(groups[0].assistantMessages).toHaveLength(2);
    expect((groups[1].message as { subtype?: string }).subtype).toBe("compacting");
    expect((groups[2].message as { subtype?: string }).subtype).toBe("compact_boundary");
  });

  test("getGroupPreview 应返回 user/system/assistant 的可读预览", () => {
    const groups = groupIntoTurns([
      {
        type: "user",
        uuid: "user-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "<attached_files>\n- foo.ts: /tmp/foo.ts\n</attached_files>\n请检查 foo.ts" }]
        }
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        message: {
          role: "assistant",
          model: "claude-sonnet-4",
          content: [{ type: "text", text: "这是 assistant 回复" }]
        }
      },
      {
        type: "system",
        subtype: "compacting",
      } as unknown as SDKMessage
    ] as SDKMessage[]);

    expect(groups).toHaveLength(3);
    expect(getGroupPreview(groups[0]!)).toContain("请检查 foo.ts");
    expect(getGroupPreview(groups[1]!)).toContain("这是 assistant 回复");
    expect(getGroupPreview(groups[2]!)).toBe("正在压缩上下文...");
  });
});

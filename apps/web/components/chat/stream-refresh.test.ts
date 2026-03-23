import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@lume/shared";
import { resolveStreamRefreshResult } from "./stream-refresh";

function createMessage(id: string): ChatMessage {
  return {
    id,
    role: "assistant",
    content: id,
    createdAt: Date.now()
  };
}

describe("stream-refresh", () => {
  test("未分页时应直接使用持久化全量消息", () => {
    const persisted = Array.from({ length: 8 }, (_, index) => createMessage(`m-${index + 1}`));
    const result = resolveStreamRefreshResult({
      persistedMessages: persisted,
      visibleCountBeforeRefresh: 6,
      hadMoreBeforeRefresh: false,
      minTailSize: 6
    });

    expect(result.hasMore).toBeFalse();
    expect(result.messages.map((item) => item.id)).toEqual(persisted.map((item) => item.id));
  });

  test("分页状态下应仅保留尾部窗口，避免前插旧消息导致滚动回弹", () => {
    const persisted = Array.from({ length: 50 }, (_, index) => createMessage(`m-${index + 1}`));
    const result = resolveStreamRefreshResult({
      persistedMessages: persisted,
      visibleCountBeforeRefresh: 12,
      hadMoreBeforeRefresh: true,
      minTailSize: 10
    });

    expect(result.hasMore).toBeTrue();
    expect(result.messages).toHaveLength(12);
    expect(result.messages[0]?.id).toBe("m-39");
    expect(result.messages[result.messages.length - 1]?.id).toBe("m-50");
  });

  test("分页状态但总量不足窗口时不应保留 hasMore", () => {
    const persisted = Array.from({ length: 9 }, (_, index) => createMessage(`m-${index + 1}`));
    const result = resolveStreamRefreshResult({
      persistedMessages: persisted,
      visibleCountBeforeRefresh: 12,
      hadMoreBeforeRefresh: true,
      minTailSize: 10
    });

    expect(result.hasMore).toBeFalse();
    expect(result.messages).toHaveLength(9);
  });
});

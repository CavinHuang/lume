import { describe, expect, test } from "bun:test";
import type { ConversationMeta } from "@lume/shared";
import {
  groupConversationsByDate,
  resolveNewConversationPromptId,
  sortConversationsByUpdatedAt
} from "./left-sidebar-conversations";

describe("left-sidebar-conversations", () => {
  test("groupConversationsByDate 应按今天/昨天/更早分组", () => {
    const now = new Date("2026-03-26T12:00:00+08:00");
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    const groups = groupConversationsByDate([
      { id: "a", updatedAt: todayStart + 1 },
      { id: "b", updatedAt: todayStart - 1 },
      { id: "c", updatedAt: todayStart - 86_400_000 - 1 }
    ], now);

    expect(groups.map((group) => group.label)).toEqual(["今天", "昨天", "更早"]);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(["a"]);
    expect(groups[1]?.items.map((item) => item.id)).toEqual(["b"]);
    expect(groups[2]?.items.map((item) => item.id)).toEqual(["c"]);
  });

  test("resolveNewConversationPromptId 应优先使用 defaultPromptId，否则回退 builtin-default", () => {
    expect(resolveNewConversationPromptId("prompt-a")).toBe("prompt-a");
    expect(resolveNewConversationPromptId(null)).toBe("builtin-default");
    expect(resolveNewConversationPromptId(undefined)).toBe("builtin-default");
  });

  test("sortConversationsByUpdatedAt 应按 updatedAt 倒序排序", () => {
    const conversations = [
      { id: "a", updatedAt: 1 },
      { id: "b", updatedAt: 3 },
      { id: "c", updatedAt: 2 }
    ] as ConversationMeta[];

    expect(sortConversationsByUpdatedAt(conversations).map((item) => item.id)).toEqual(["b", "c", "a"]);
  });
});

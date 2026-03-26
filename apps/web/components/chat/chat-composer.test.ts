import { describe, expect, test } from "bun:test";
import type { FileAttachment } from "@lume/shared";
import {
  filterValidContextDividers,
  mergeInlineEditAttachments,
  shouldPrepareConversationAutoTitle
} from "./chat-composer";

describe("chat-composer", () => {
  test("首次发送或默认标题会话应准备自动标题", () => {
    expect(shouldPrepareConversationAutoTitle({
      content: "你好",
      messageCountBeforeSend: 0,
      currentTitle: "新对话",
      hasPendingTitle: false
    })).toBe(true);

    expect(shouldPrepareConversationAutoTitle({
      content: "继续",
      messageCountBeforeSend: 3,
      currentTitle: "新对话",
      hasPendingTitle: false
    })).toBe(true);
  });

  test("已有非默认标题、空内容或已有 pending title 时不应准备自动标题", () => {
    expect(shouldPrepareConversationAutoTitle({
      content: "继续",
      messageCountBeforeSend: 3,
      currentTitle: "自定义标题",
      hasPendingTitle: false
    })).toBe(false);

    expect(shouldPrepareConversationAutoTitle({
      content: "   ",
      messageCountBeforeSend: 0,
      currentTitle: "新对话",
      hasPendingTitle: false
    })).toBe(false);

    expect(shouldPrepareConversationAutoTitle({
      content: "继续",
      messageCountBeforeSend: 0,
      currentTitle: "新对话",
      hasPendingTitle: true
    })).toBe(false);
  });

  test("filterValidContextDividers 应移除已不存在的 divider", () => {
    expect(filterValidContextDividers(["m1", "m2", "m3"], [
      { id: "m1" },
      { id: "m3" }
    ])).toEqual(["m1", "m3"]);
  });

  test("mergeInlineEditAttachments 应保留旧附件并追加新附件", () => {
    const kept: FileAttachment[] = [
      { id: "att-a", filename: "a.txt", mediaType: "text/plain", localPath: "/a.txt", size: 1 }
    ];
    const added: FileAttachment[] = [
      { id: "att-b", filename: "b.txt", mediaType: "text/plain", localPath: "/b.txt", size: 1 }
    ];

    expect(mergeInlineEditAttachments({ kept, added })).toEqual([...kept, ...added]);
  });
});

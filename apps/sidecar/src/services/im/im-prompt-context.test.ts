import { describe, expect, test } from "bun:test";
import { buildImUserMessage } from "./im-message-router";
import type { InboundImRouteMessage } from "./im-message-router";

function msg(overrides: Partial<InboundImRouteMessage> = {}): InboundImRouteMessage {
  return {
    provider: "feishu",
    accountId: "a1",
    peerKind: "dm",
    peerId: "oc_u",
    text: "正文内容",
    ...overrides
  };
}

describe("buildImUserMessage", () => {
  test("无引用时保持纯文本（历史行为不变）", () => {
    expect(buildImUserMessage(msg())).toBe("正文内容");
    expect(buildImUserMessage(msg({ peerKind: "group", senderId: "ou_a" }))).toBe("ou_a: 正文内容");
  });

  test("有引用时以 XML 块注入，正文包进 user_message", () => {
    const result = buildImUserMessage(msg(), { senderId: "ou_q", text: "被引用的消息" });
    expect(result).toBe(
      [
        "<im_context>",
        '<quoted_message sender="ou_q">',
        "被引用的消息",
        "</quoted_message>",
        "<user_message>",
        "正文内容",
        "</user_message>",
        "</im_context>"
      ].join("\n")
    );
  });

  test("群聊+引用：发送者前缀保留在 user_message 内", () => {
    const result = buildImUserMessage(
      msg({ peerKind: "group", senderId: "ou_a" }),
      { text: "引用文本" }
    );
    expect(result).toContain("<quoted_message>");
    expect(result).toContain("ou_a: 正文内容");
  });

  test("空引用文本视为无引用", () => {
    expect(buildImUserMessage(msg(), null)).toBe("正文内容");
    expect(buildImUserMessage(msg(), { text: "" })).toBe("正文内容");
  });
});

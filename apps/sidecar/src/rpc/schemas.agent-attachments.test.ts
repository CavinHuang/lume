import { describe, expect, test } from "bun:test";
import { agentAppendInputSchema, agentSendInputSchema } from "./schemas";
import { validateInput } from "./validation";

describe("agentSendInputSchema messageAttachments", () => {
  test("accepts thread-relative message attachment references", () => {
    const parsed = agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "read this",
      messageAttachments: [{
        id: "att-1",
        filename: "brief.md",
        mediaType: "text/markdown",
        size: 1200,
        threadPath: "files/brief.md"
      }]
    });

    expect(parsed.messageAttachments).toHaveLength(1);
    expect(parsed.messageAttachments?.[0]?.threadPath).toBe("files/brief.md");
  });

  test("rejects invalid message attachment references", () => {
    const base = {
      threadId: "thread-1",
      userMessage: "read this",
      messageAttachments: [{
        id: "att-1",
        filename: "brief.md",
        mediaType: "text/markdown",
        size: 1200,
        threadPath: "files/brief.md"
      }]
    };

    expect(() => agentSendInputSchema.parse({
      ...base,
      messageAttachments: [{ ...base.messageAttachments[0], threadPath: undefined }]
    })).toThrow();
    expect(() => agentSendInputSchema.parse({
      ...base,
      messageAttachments: [{ ...base.messageAttachments[0], size: -1 }]
    })).toThrow();
    expect(() => agentSendInputSchema.parse({
      ...base,
      messageAttachments: [{ ...base.messageAttachments[0], filename: "" }]
    })).toThrow();
    expect(() => agentSendInputSchema.parse({
      ...base,
      messageAttachments: [{ ...base.messageAttachments[0], threadPath: "/tmp/a.txt" }]
    })).toThrow();
    expect(() => agentSendInputSchema.parse({
      ...base,
      messageAttachments: [{ ...base.messageAttachments[0], threadPath: "../a.txt" }]
    })).toThrow();
  });
});

describe("agentSendInputSchema browserAttachments", () => {
  test("accepts authorized browser references and legacy browser tabs", () => {
    const parsed = agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "read this page",
      browserAttachments: [{
        id: "browser-tab:iab:provider-1:3",
        origin: "browser-tab",
        backend: "iab",
        browserId: "lume-iab",
        referenceGrantId: "grant-1",
        access: "control",
        tabId: "tab-1",
        providerTabId: "provider-1",
        title: "Example",
        url: "https://example.com/",
        generation: 3,
        lastOpenedAt: "2026-08-01T00:00:00.000Z",
        ownerThreadId: "thread-1"
      }, {
        id: "legacy-tab",
        origin: "browser-tab",
        tabId: "tab-old",
        providerTabId: "provider-old",
        title: "Legacy",
        url: "https://legacy.example/",
        generation: 1
      }]
    });

    expect(parsed.browserAttachments).toHaveLength(2);
  });

  test("rejects invalid browser reference fields", () => {
    const attachment = {
      id: "browser-tab:1",
      origin: "browser-tab",
      backend: "iab",
      browserId: "lume-iab",
      referenceGrantId: "grant-1",
      access: "control",
      tabId: "tab-1",
      title: "Example",
      url: "https://example.com/"
    };
    expect(() => agentSendInputSchema.parse({ threadId: "thread-1", userMessage: "read", browserAttachments: [{ ...attachment, backend: "firefox" }] })).toThrow();
    expect(() => agentSendInputSchema.parse({ threadId: "thread-1", userMessage: "read", browserAttachments: [{ ...attachment, referenceGrantId: "" }] })).toThrow();
  });

  test("accepts a comment attached to browser design changes", () => {
    const parsed = agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "apply these adjustments",
      browserAttachments: [{
        id: "browser-design-change:1",
        origin: "browser-design-change",
        tab: {
          id: "browser-tab:1",
          origin: "browser-tab",
          tabId: "tab-1",
          title: "Example",
          url: "https://example.com/",
          generation: 2
        },
        anchor: {
          kind: "element",
          url: "https://example.com/",
          generation: 2,
          framePath: [],
          domPath: "html > body > main",
          selectedContent: "Primary heading",
          rect: { x: 10, y: 20, width: 200, height: 100 }
        },
        originalStyles: { color: "rgb(0, 0, 0)" },
        proposedStyles: { color: "rgb(2, 133, 255)" },
        body: "Use the primary accent color"
      }]
    });

    expect(parsed.browserAttachments?.[0]).toMatchObject({ body: "Use the primary accent color" });
  });

  test("rejects a browser screenshot reference owned by another thread", () => {
    expect(() => agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "read this page",
      browserAttachments: [{
        id: "annotation-1",
        origin: "browser-annotation",
        tab: { id: "browser-tab:1", origin: "browser-tab", tabId: "tab-1", title: "Example", url: "https://example.com/", generation: 1 },
        anchor: { kind: "element", url: "https://example.com/", generation: 1, framePath: [], rect: { x: 0, y: 0, width: 1, height: 1 } },
        body: "Review this",
        screenshotRef: "browser-review-screenshot:thread-2:11111111-1111-4111-8111-111111111111",
      }],
    })).toThrow();
  });

  test("rejects malformed browser screenshot references", () => {
    expect(() => agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "read this page",
      browserAttachments: [{
        id: "annotation-1",
        origin: "browser-annotation",
        tab: { id: "browser-tab:1", origin: "browser-tab", tabId: "tab-1", title: "Example", url: "https://example.com/", generation: 1 },
        anchor: { kind: "element", url: "https://example.com/", generation: 1, framePath: [], rect: { x: 0, y: 0, width: 1, height: 1 } },
        body: "Review this",
        screenshotRef: "temporary-file.png",
      }],
    })).toThrow();
  });
});

// 三态路由契约:经 validateInput(RPC 入口)提交 followUpQueueMode 时不可被 strip。
// 回归:zod 默认 unknownKeys='strip' + schema 未声明字段会被丢弃 → agent-service 三态路由恒走 queue。
describe("agentSendInputSchema followUpQueueMode (RPC contract)", () => {
  test("validateInput 保留 followUpQueueMode='steer'(不被 strip)", () => {
    const parsed = validateInput(
      agentSendInputSchema,
      { threadId: "t1", userMessage: "hi", followUpQueueMode: "steer" },
      "agent.send",
    );
    expect(parsed.followUpQueueMode).toBe("steer");
  });

  test("validateInput 保留 followUpQueueMode='interrupt'(不被 strip)", () => {
    const parsed = validateInput(
      agentSendInputSchema,
      { threadId: "t1", userMessage: "hi", followUpQueueMode: "interrupt" },
      "agent.append",
    );
    expect(parsed.followUpQueueMode).toBe("interrupt");
  });

  test("validateInput 接受 followUpQueueMode='queue' 与缺省(undefined)", () => {
    const queued = validateInput(
      agentSendInputSchema,
      { threadId: "t1", userMessage: "hi", followUpQueueMode: "queue" },
      "agent.send",
    );
    expect(queued.followUpQueueMode).toBe("queue");

    const omitted = validateInput(
      agentSendInputSchema,
      { threadId: "t1", userMessage: "hi" },
      "agent.send",
    );
    expect(omitted.followUpQueueMode).toBeUndefined();
  });

  test("validateInput 拒绝非法 followUpQueueMode 值", () => {
    expect(() => validateInput(
      agentSendInputSchema,
      { threadId: "t1", userMessage: "hi", followUpQueueMode: "bogus" },
      "agent.send",
    )).toThrow();
  });

  test("agentAppendInputSchema 同步保留 followUpQueueMode(别名)", () => {
    // agentAppendInputSchema 是 agentSendInputSchema 的别名,字段同步覆盖
    const parsed = validateInput(
      agentAppendInputSchema,
      { threadId: "t1", userMessage: "hi", followUpQueueMode: "steer" },
      "agent.append",
    );
    expect(parsed.followUpQueueMode).toBe("steer");
  });
});

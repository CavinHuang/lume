import { describe, expect, test } from "bun:test";
import { agentSendInputSchema } from "./schemas";

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

  const validDesignChangeAttachment = {
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
    proposedStyles: { color: "rgb(2, 133, 255)" }
  };

  test("accepts a browser design change with declarations, groupId and text", () => {
    const parsed = agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "apply these declarations",
      browserAttachments: [{
        ...validDesignChangeAttachment,
        declarations: [
          { property: "color", value: "#fff", previousValue: "#000" },
          { property: "font-size", value: "16px", previousValue: "14px", placeholderValue: "1rem" }
        ],
        groupId: "browser-design-change:1",
        text: { previousValue: "Hello", value: "Hi" }
      }]
    });

    expect(parsed.browserAttachments?.[0]).toMatchObject({
      declarations: [
        { property: "color", value: "#fff", previousValue: "#000" },
        { property: "font-size", value: "16px", previousValue: "14px", placeholderValue: "1rem" }
      ],
      groupId: "browser-design-change:1",
      text: { previousValue: "Hello", value: "Hi" }
    });
  });

  test("rejects design change declarations missing property or value", () => {
    expect(() => agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "apply",
      browserAttachments: [{
        ...validDesignChangeAttachment,
        declarations: [{ value: "#fff", previousValue: "#000" }]
      }]
    })).toThrow();
    expect(() => agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "apply",
      browserAttachments: [{
        ...validDesignChangeAttachment,
        declarations: [{ property: "color", previousValue: "#000" }]
      }]
    })).toThrow();
  });

  test("rejects design change declarations with invalid property name", () => {
    expect(() => agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "apply",
      browserAttachments: [{
        ...validDesignChangeAttachment,
        declarations: [{ property: "123bad", value: "#fff", previousValue: "#000" }]
      }]
    })).toThrow();
  });

  test("rejects more than 64 design change declarations", () => {
    const declarations = Array.from({ length: 65 }, (_, i) => ({
      property: "color",
      value: `rgb(${i}, 0, 0)`,
      previousValue: "rgb(0, 0, 0)"
    }));
    expect(() => agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "apply",
      browserAttachments: [{ ...validDesignChangeAttachment, declarations }]
    })).toThrow();
  });

  test("accepts 64 design change declarations at the limit", () => {
    const declarations = Array.from({ length: 64 }, (_, i) => ({
      property: "color",
      value: `rgb(${i}, 0, 0)`,
      previousValue: "rgb(0, 0, 0)"
    }));
    const parsed = agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "apply",
      browserAttachments: [{ ...validDesignChangeAttachment, declarations }]
    });
    expect(parsed.browserAttachments?.[0]).toMatchObject({ declarations: { length: 64 } });
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

// Task 91：浏览器批注 PR diff 评审字段（reviewThreadId/inReplyToId/isResolved/resolvedAt/resolvedBy/author/readAt）
describe("agentSendInputSchema browser-annotation review fields", () => {
  const validAnnotation = {
    id: "annotation-1",
    origin: "browser-annotation",
    tab: { id: "browser-tab:1", origin: "browser-tab", tabId: "tab-1", title: "Example", url: "https://example.com/", generation: 1 },
    anchor: { kind: "element", url: "https://example.com/", generation: 1, framePath: [], rect: { x: 0, y: 0, width: 1, height: 1 } },
    body: "Review this"
  };

  const reviewFields = {
    reviewThreadId: "thread-abc",
    inReplyToId: "comment-parent",
    isResolved: true,
    resolvedAt: "2026-08-03T12:00:00.000Z",
    resolvedBy: "user",
    author: { kind: "user", name: "Alice" },
    readAt: "2026-08-03T12:05:00.000Z"
  };

  test("accepts all seven optional review fields", () => {
    const parsed = agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "review this",
      browserAttachments: [{ ...validAnnotation, ...reviewFields }]
    });
    expect(parsed.browserAttachments?.[0]).toMatchObject(reviewFields);
  });

  test("accepts agent-authored annotation with minimal author", () => {
    const parsed = agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "review this",
      browserAttachments: [{ ...validAnnotation, author: { kind: "agent" }, isResolved: false }]
    });
    expect(parsed.browserAttachments?.[0]).toMatchObject({ author: { kind: "agent" }, isResolved: false });
  });

  test("accepts legacy payload without review fields (backward compat)", () => {
    const parsed = agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "review this",
      browserAttachments: [validAnnotation]
    });
    expect(parsed.browserAttachments?.[0]).toMatchObject({ body: "Review this" });
  });

  test("rejects reviewThreadId exceeding 256 chars", () => {
    expect(() => agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "review",
      browserAttachments: [{ ...validAnnotation, reviewThreadId: "x".repeat(257) }]
    })).toThrow();
  });

  test("rejects inReplyToId exceeding 256 chars", () => {
    expect(() => agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "review",
      browserAttachments: [{ ...validAnnotation, inReplyToId: "y".repeat(257) }]
    })).toThrow();
  });

  test("rejects non-boolean isResolved", () => {
    expect(() => agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "review",
      browserAttachments: [{ ...validAnnotation, isResolved: "yes" }]
    })).toThrow();
  });

  test("rejects resolvedAt exceeding 64 chars", () => {
    expect(() => agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "review",
      browserAttachments: [{ ...validAnnotation, resolvedAt: "z".repeat(65) }]
    })).toThrow();
  });

  test("rejects readAt exceeding 64 chars", () => {
    expect(() => agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "review",
      browserAttachments: [{ ...validAnnotation, readAt: "z".repeat(65) }]
    })).toThrow();
  });

  test("rejects resolvedBy outside user|agent enum", () => {
    expect(() => agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "review",
      browserAttachments: [{ ...validAnnotation, resolvedBy: "system" }]
    })).toThrow();
  });

  test("rejects author.kind outside user|agent enum", () => {
    expect(() => agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "review",
      browserAttachments: [{ ...validAnnotation, author: { kind: "bot" } }]
    })).toThrow();
  });

  test("rejects author.name exceeding 256 chars", () => {
    expect(() => agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "review",
      browserAttachments: [{ ...validAnnotation, author: { kind: "user", name: "n".repeat(257) } }]
    })).toThrow();
  });

  test("rejects author with unexpected extra field (strict)", () => {
    expect(() => agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "review",
      browserAttachments: [{ ...validAnnotation, author: { kind: "user", email: "a@b.c" } }]
    })).toThrow();
  });
});

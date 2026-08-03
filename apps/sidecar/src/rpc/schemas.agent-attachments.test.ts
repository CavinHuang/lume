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

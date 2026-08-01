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
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChatToolActivity } from "@lume/shared";
import { updateChatToolCredentials, updateChatToolState } from "./chat-tool-manager";
import { runEnabledToolsForChat } from "./chat-tool-execution-service";

describe("chat-tool-execution-service", () => {
  let prevConfigDir: string | undefined;
  let prevFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    prevFetch = globalThis.fetch;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-chat-tool-execution-"));
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }

    if (prevFetch) {
      globalThis.fetch = prevFetch;
    }
  });

  test("web_search 可用时应把 provider 结果附加到上下文", async () => {
    updateChatToolState("web_search", { enabled: true });
    updateChatToolCredentials("web_search", {
      braveApiKey: "brave-key",
      tavilyApiKey: ""
    });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!url.includes("api.search.brave.com")) {
        return new Response("unexpected endpoint", { status: 500 });
      }

      return new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: "Brave Result",
                url: "https://example.com",
                description: "ok"
              }
            ]
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }) as typeof fetch;

    const activities: ChatToolActivity[] = [];
    const result = await runEnabledToolsForChat({
      conversationId: "conversation-id",
      userMessage: "查询今天最新的 AI 新闻",
      messageHistory: [],
      enabledToolIds: ["web_search"],
      emitToolActivity: (activity) => {
        activities.push(activity);
      }
    });

    expect(result.contextAppendix).toContain("web_search(brave)");
    expect(result.contextAppendix).toContain("Brave Result");
    expect(activities.some((activity) => activity.type === "start" && activity.toolName === "web_search")).toBeTrue();
    expect(activities.some((activity) => activity.type === "result" && activity.toolName === "web_search")).toBeTrue();
  });
});

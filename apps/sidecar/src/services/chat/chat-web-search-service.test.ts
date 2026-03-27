import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { searchWeb, testWebSearchConnection } from "./chat-web-search-service";
import { updateChatToolCredentials } from "./chat-tool-manager";

describe("chat-web-search-service", () => {
  let prevFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    prevFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (prevFetch) {
      globalThis.fetch = prevFetch;
    }
  });

  test("配置 brave key 时应优先返回 brave provider 结果", async () => {
    const credentials = {
      braveApiKey: "brave-key",
      tavilyApiKey: ""
    };
    updateChatToolCredentials("web_search", credentials);

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
          headers: { "content-type": "application/json" }
        }
      );
    }) as typeof fetch;

    const result = await searchWeb("latest ai news", credentials);
    expect(result.provider).toBe("brave");
    expect(result.result).toContain("Brave Result");
  });

  test("未配置 key 时应回退到 DuckDuckGo 连通性测试", async () => {
    updateChatToolCredentials("web_search", {
      braveApiKey: "",
      tavilyApiKey: ""
    });

    let requestedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = typeof input === "string" ? input : input.toString();
      return new Response("<html>ok</html>", { status: 200 });
    }) as typeof fetch;

    const result = await testWebSearchConnection({
      braveApiKey: "",
      tavilyApiKey: ""
    });

    expect(result.success).toBeTrue();
    expect(requestedUrl).toContain("duckduckgo.com");
  });
});

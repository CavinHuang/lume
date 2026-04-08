import { Type } from "@sinclair/typebox";
import { WebFetchTool, WebSearchTool, type ToolDefinition } from "@lume/agent-sdk";
import { createSdkJsonResultTool } from "../sdk-tool-result";

export const WEB_TOOL_NAMES = ["web_search", "web_fetch"] as const;

function parseSdkToolPayload(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function executeWebSearch(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const provider = typeof params.provider === "string" ? params.provider.trim().toLowerCase() : "";
  if (provider && provider !== "duckduckgo" && provider !== "ddg") {
    return {
      error: `SDK WebSearch 当前仅支持 duckduckgo 兼容模式，不支持 provider=${provider}`,
      provider,
      results: []
    };
  }

  const result = await WebSearchTool.call(
    {
      query: typeof params.query === "string" ? params.query : "",
      ...(typeof params.count === "number" ? { num_results: params.count } : {})
    },
    {
      cwd: process.cwd()
    }
  );

  if (result.is_error) {
    return {
      error: String(result.content),
      provider: "duckduckgo",
      results: []
    };
  }

  const payload = parseSdkToolPayload(String(result.content));
  const results = Array.isArray(payload.results) ? payload.results : [];
  return {
    provider: "duckduckgo",
    query: payload.query,
    count: results.length,
    results
  };
}

async function executeWebFetch(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await WebFetchTool.call(
    {
      url: typeof params.url === "string" ? params.url : "",
      ...(params.headers && typeof params.headers === "object"
        ? { headers: params.headers as Record<string, string> }
        : {})
    },
    {
      cwd: process.cwd()
    }
  );

  if (result.is_error) {
    return {
      url: params.url,
      error: String(result.content)
    };
  }

  const payload = parseSdkToolPayload(String(result.content));
  return {
    url: payload.url,
    contentType: payload.contentType,
    text: payload.content
  };
}

export function createSdkWebTools(): ToolDefinition[] {
  return [
    createSdkJsonResultTool({
      name: "web_search",
      description: "Search the web using the SDK built-in WebSearch tool.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          count: { type: "number", minimum: 1, maximum: 10 },
          provider: { type: "string" }
        },
        required: ["query"]
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      call: executeWebSearch
    }),
    createSdkJsonResultTool({
      name: "web_fetch",
      description: "Fetch web content using the SDK built-in WebFetch tool.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", minLength: 1 },
          headers: {
            type: "object",
            properties: {},
          }
        },
        required: ["url"]
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      call: executeWebFetch
    })
  ];
}


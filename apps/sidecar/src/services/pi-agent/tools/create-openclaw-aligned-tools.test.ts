import { describe, expect, test, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { appendAgentMessage, createAgentSession } from "../../agent-session-manager";
import type { AgentTool } from "@mariozechner/pi-agent-core";

mock.module("undici", () => ({
  EnvHttpProxyAgent: class {},
  setGlobalDispatcher: () => undefined
}));

async function loadCreateOpenClawAlignedTools() {
  const mod = await import("./create-openclaw-aligned-tools");
  return mod.createOpenClawAlignedTools;
}

function resolveTool(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((item) => item.name === name);
  if (!tool) {
    throw new Error(`tool not found: ${name}`);
  }
  return tool;
}

describe("create-openclaw-aligned-tools", () => {
  test("subagent 会话应拒绝 sessions_spawn", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: "agent:main:subagent:test"
      });
      const spawnTool = resolveTool(tools as unknown as AgentTool[], "sessions_spawn");
      const result = await spawnTool.execute("tool-call-1", { task: "do work" });
      const details = result.details as { status?: string; error?: string };
      expect(details.status).toBe("error");
      expect(details.error).toContain("not allowed from sub-agent sessions");
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("subagent 会话应拒绝 sessions_send 与 agents_list", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: "agent:main:subagent:test"
      });
      const sendTool = resolveTool(tools as unknown as AgentTool[], "sessions_send");
      const sendResult = await sendTool.execute("tool-call-send", {
        sessionKey: "main",
        message: "hello"
      });
      const sendDetails = sendResult.details as { status?: string; error?: string };
      expect(sendDetails.status).toBe("error");
      expect(sendDetails.error).toContain("sessions_send is not allowed from sub-agent sessions");

      const agentsListTool = resolveTool(tools as unknown as AgentTool[], "agents_list");
      const listResult = await agentsListTool.execute("tool-call-list", {});
      const listDetails = listResult.details as { status?: string; error?: string };
      expect(listDetails.status).toBe("error");
      expect(listDetails.error).toContain("agents_list is not allowed from sub-agent sessions");
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("sessions_history 未传 sessionKey/label 时应返回错误", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const current = createAgentSession("当前会话");
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: current.id
      });
      const historyTool = resolveTool(tools as unknown as AgentTool[], "sessions_history");
      const result = await historyTool.execute("tool-call-2", {});
      const details = result.details as { status?: string; error?: string };
      expect(details.status).toBe("error");
      expect(details.error).toContain("Either sessionKey or label is required");
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("sessions_history 应支持通过 label 读取目标会话历史", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const current = createAgentSession("当前会话");
      const target = createAgentSession("目标会话");
      appendAgentMessage(target.id, {
        id: randomUUID(),
        role: "user",
        content: "hello",
        createdAt: Date.now()
      });
      appendAgentMessage(target.id, {
        id: randomUUID(),
        role: "assistant",
        content: "world",
        createdAt: Date.now(),
        model: "test/model"
      });

      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: current.id
      });
      const historyTool = resolveTool(tools as unknown as AgentTool[], "sessions_history");
      const result = await historyTool.execute("tool-call-3", {
        label: "目标会话",
        limit: 10
      });
      const details = result.details as {
        status?: string;
        sessionKey?: string;
        count?: number;
        messages?: Array<{ content?: string }>;
      };
      expect(details.status).toBe("ok");
      expect(details.sessionKey).toBe(target.id);
      expect(details.count).toBe(2);
      expect(details.messages?.[0]?.content).toBe("hello");
      expect(details.messages?.[1]?.content).toBe("world");
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("web_search 应解析 duckduckgo HTML 结果", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    const originalFetch = globalThis.fetch;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    globalThis.fetch = mock(async () =>
      new Response(
        `
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpath%3Fa%3D1&amp;rut=abc">Example Title</a>
        <a class="result__snippet">This is a description</a>
      `,
        { status: 200, headers: { "content-type": "text/html" } }
      )
    ) as unknown as typeof fetch;

    try {
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({ sessionId: "agent:main:test" });
      const webSearchTool = resolveTool(tools as unknown as AgentTool[], "web_search");
      const result = await webSearchTool.execute("tool-call-web", {
        query: "example"
      });
      const details = result.details as {
        provider?: string;
        count?: number;
        results?: Array<{ title?: string; url?: string; snippet?: string }>;
      };
      expect(details.provider).toBe("duckduckgo");
      expect(details.count).toBe(1);
      expect(details.results?.[0]?.title).toBe("Example Title");
      expect(details.results?.[0]?.url).toBe("https://example.com/path?a=1");
      expect(details.results?.[0]?.snippet).toContain("description");
    } finally {
      globalThis.fetch = originalFetch;
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("web_search brave 缺少 key 时应返回明确错误", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    const previousBraveKey = process.env.BRAVE_SEARCH_API_KEY;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    delete process.env.BRAVE_SEARCH_API_KEY;
    try {
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({ sessionId: "agent:main:test" });
      const webSearchTool = resolveTool(tools as unknown as AgentTool[], "web_search");
      const result = await webSearchTool.execute("tool-call-web-brave", {
        query: "example",
        provider: "brave"
      });
      const details = result.details as { error?: string };
      expect(details.error).toContain("braveApiKey");
    } finally {
      if (previousBraveKey === undefined) {
        delete process.env.BRAVE_SEARCH_API_KEY;
      } else {
        process.env.BRAVE_SEARCH_API_KEY = previousBraveKey;
      }
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("web_search tavily 缺少 key 时应返回明确错误", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    const previousTavilyKey = process.env.TAVILY_API_KEY;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    delete process.env.TAVILY_API_KEY;
    try {
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({ sessionId: "agent:main:test" });
      const webSearchTool = resolveTool(tools as unknown as AgentTool[], "web_search");
      const result = await webSearchTool.execute("tool-call-web-tavily", {
        query: "example",
        provider: "tavily"
      });
      const details = result.details as { error?: string };
      expect(details.error).toContain("tavilyApiKey");
    } finally {
      if (previousTavilyKey === undefined) {
        delete process.env.TAVILY_API_KEY;
      } else {
        process.env.TAVILY_API_KEY = previousTavilyKey;
      }
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("web_search duckduckgo 超时应返回结构化错误码", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    const previousBraveKey = process.env.BRAVE_SEARCH_API_KEY;
    const previousTavilyKey = process.env.TAVILY_API_KEY;
    const originalFetch = globalThis.fetch;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.TAVILY_API_KEY;
    globalThis.fetch = mock(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as unknown as typeof fetch;

    try {
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({ sessionId: "agent:main:test" });
      const webSearchTool = resolveTool(tools as unknown as AgentTool[], "web_search");
      const result = await webSearchTool.execute("tool-call-web-timeout", {
        query: "timeout case"
      });
      const details = result.details as { code?: string; error?: string; provider?: string };
      expect(details.code).toBe("WEB_SEARCH_TIMEOUT");
      expect(details.provider).toBe("duckduckgo");
      expect(details.error).toContain("请求超时");
    } finally {
      globalThis.fetch = originalFetch;
      if (previousBraveKey === undefined) {
        delete process.env.BRAVE_SEARCH_API_KEY;
      } else {
        process.env.BRAVE_SEARCH_API_KEY = previousBraveKey;
      }
      if (previousTavilyKey === undefined) {
        delete process.env.TAVILY_API_KEY;
      } else {
        process.env.TAVILY_API_KEY = previousTavilyKey;
      }
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("web_search duckduckgo 失败时应自动降级到 brave", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    const previousBraveKey = process.env.BRAVE_SEARCH_API_KEY;
    const originalFetch = globalThis.fetch;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    process.env.BRAVE_SEARCH_API_KEY = "test-key";

    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount += 1;
      if (callCount <= 4) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: "Brave Result",
                url: "https://example.org",
                description: "fallback result"
              }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    try {
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({ sessionId: "agent:main:test" });
      const webSearchTool = resolveTool(tools as unknown as AgentTool[], "web_search");
      const result = await webSearchTool.execute("tool-call-web-fallback", {
        query: "fallback case"
      });
      const details = result.details as {
        provider?: string;
        fallbackFrom?: string;
        count?: number;
        results?: Array<{ title?: string }>;
      };
      expect(details.provider).toBe("brave");
      expect(details.fallbackFrom).toBe("duckduckgo");
      expect(details.count).toBe(1);
      expect(details.results?.[0]?.title).toBe("Brave Result");
      expect(callCount).toBe(5);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousBraveKey === undefined) {
        delete process.env.BRAVE_SEARCH_API_KEY;
      } else {
        process.env.BRAVE_SEARCH_API_KEY = previousBraveKey;
      }
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("web_search duckduckgo 失败且 brave 不可用时应降级到 tavily", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    const previousBraveKey = process.env.BRAVE_SEARCH_API_KEY;
    const previousTavilyKey = process.env.TAVILY_API_KEY;
    const originalFetch = globalThis.fetch;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    delete process.env.BRAVE_SEARCH_API_KEY;
    process.env.TAVILY_API_KEY = "test-tavily";

    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount += 1;
      if (callCount <= 4) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Tavily Result",
              url: "https://example.net",
              content: "fallback from tavily"
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    try {
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({ sessionId: "agent:main:test" });
      const webSearchTool = resolveTool(tools as unknown as AgentTool[], "web_search");
      const result = await webSearchTool.execute("tool-call-web-tavily-fallback", {
        query: "fallback tavily case",
        braveApiKey: ""
      });
      const details = result.details as {
        provider?: string;
        fallbackFrom?: string;
        count?: number;
        results?: Array<{ title?: string }>;
      };
      expect(details.provider).toBe("tavily");
      expect(details.fallbackFrom).toBe("duckduckgo");
      expect(details.count).toBe(1);
      expect(details.results?.[0]?.title).toBe("Tavily Result");
      expect(callCount).toBe(5);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousBraveKey === undefined) {
        delete process.env.BRAVE_SEARCH_API_KEY;
      } else {
        process.env.BRAVE_SEARCH_API_KEY = previousBraveKey;
      }
      if (previousTavilyKey === undefined) {
        delete process.env.TAVILY_API_KEY;
      } else {
        process.env.TAVILY_API_KEY = previousTavilyKey;
      }
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });
});

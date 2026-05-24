import { describe, expect, test } from "bun:test";
import {
  createWorkspaceMcpResourceTools,
  createWorkspaceMcpToolDefinitions
} from "./create-mcp-tools";
import type { McpCallResult, ToolDefinition } from "@lume/agent-sdk";
import type { McpToolDetail } from "@lume/shared";

const toolDetail: McpToolDetail = {
  name: "mcp__github__search_issues",
  originalName: "search/issues",
  wrapperName: "mcp__github__search_issues",
  description: "Search GitHub issues",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  serverId: "github",
  serverName: "GitHub"
};

describe("createWorkspaceMcpToolDefinitions", () => {
  test("uses wrapperName and preserves tool metadata", () => {
    const tools = createWorkspaceMcpToolDefinitions({
      workspaceSlug: "demo",
      tools: [toolDetail],
      callTool: async () => ({ text: "ok" })
    });

    expect(tools[0]?.name).toBe("mcp__github__search_issues");
    expect(tools[0]?.description).toBe("Search GitHub issues");
    expect(tools[0]?.inputSchema).toEqual(toolDetail.inputSchema as ToolDefinition["inputSchema"]);
    expect(tools[0]?.isReadOnly?.()).toBe(false);
    expect(tools[0]?.isConcurrencySafe?.()).toBe(false);
  });

  test("forwards workspaceSlug, serverId, originalToolName, args, and AbortSignal", async () => {
    const controller = new AbortController();
    const calls: Array<{
      workspaceSlug: string;
      serverId: string;
      originalToolName: string;
      args: Record<string, unknown>;
      signal?: AbortSignal;
    }> = [];
    const tools = createWorkspaceMcpToolDefinitions({
      workspaceSlug: "demo",
      tools: [toolDetail],
      callTool: async (workspaceSlug, serverId, originalToolName, args, options) => {
        calls.push({ workspaceSlug, serverId, originalToolName, args, signal: options?.signal });
        return { text: "ok" };
      }
    });

    const result = await tools[0]!.call(
      { q: "lume" },
      { cwd: "/tmp", toolUseId: "tool-1", abortSignal: controller.signal }
    );

    expect(calls).toEqual([{
      workspaceSlug: "demo",
      serverId: "github",
      originalToolName: "search/issues",
      args: { q: "lume" },
      signal: controller.signal
    }]);
    expect(result).toEqual({ type: "tool_result", tool_use_id: "tool-1", content: "ok" });
  });

  test("maps manager errors to tool errors", async () => {
    const tools = createWorkspaceMcpToolDefinitions({
      workspaceSlug: "demo",
      tools: [toolDetail],
      callTool: async () => {
        throw new Error("boom");
      }
    });

    const result = await tools[0]!.call({}, { cwd: "/tmp", toolUseId: "tool-1" });

    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("boom");
  });

  test("preserves isError and truncated state in returned content", async () => {
    const callResult: McpCallResult = { text: "partial", isError: true, truncated: true };
    const tools = createWorkspaceMcpToolDefinitions({
      workspaceSlug: "demo",
      tools: [toolDetail],
      callTool: async () => callResult
    });

    const result = await tools[0]!.call({}, { cwd: "/tmp", toolUseId: "tool-1" });

    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("partial");
    expect(String(result.content)).toContain("truncated");
  });
});

describe("createWorkspaceMcpResourceTools", () => {
  test("creates stable resource tool names", () => {
    const tools = createWorkspaceMcpResourceTools({
      workspaceSlug: "demo",
      listResources: async () => ({ resources: [] }),
      readResource: async () => ({ serverId: "github", uri: "file://a", contents: [] })
    });

    expect(tools.map((tool) => tool.name)).toEqual(["ListMcpResourcesTool", "ReadMcpResourceTool"]);
  });

  test("resource tools call back through the captured workspaceSlug", async () => {
    const calls: unknown[] = [];
    const tools = createWorkspaceMcpResourceTools({
      workspaceSlug: "demo",
      listResources: async (workspaceSlug, serverId) => {
        calls.push({ kind: "list", workspaceSlug, serverId });
        return { resources: [{ serverId: "github", serverName: "GitHub", uri: "file://a" }] };
      },
      readResource: async (workspaceSlug, serverId, uri) => {
        calls.push({ kind: "read", workspaceSlug, serverId, uri });
        return { serverId, uri, contents: [{ text: "hello" }] };
      }
    });

    const listResult = await tools[0]!.call({ serverId: "github" }, { cwd: "/tmp", toolUseId: "list-1" });
    const readResult = await tools[1]!.call({ serverId: "github", uri: "file://a" }, { cwd: "/tmp", toolUseId: "read-1" });

    expect(calls).toEqual([
      { kind: "list", workspaceSlug: "demo", serverId: "github" },
      { kind: "read", workspaceSlug: "demo", serverId: "github", uri: "file://a" }
    ]);
    expect(String(listResult.content)).toContain("file://a");
    expect(String(readResult.content)).toContain("hello");
  });

  test("ReadMcpResourceTool requires serverId and uri", async () => {
    const tools = createWorkspaceMcpResourceTools({
      workspaceSlug: "demo",
      listResources: async () => ({ resources: [] }),
      readResource: async () => ({ serverId: "github", uri: "file://a", contents: [] })
    });

    const result = await tools[1]!.call({ serverId: "github" }, { cwd: "/tmp", toolUseId: "read-1" });

    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("uri");
  });
});

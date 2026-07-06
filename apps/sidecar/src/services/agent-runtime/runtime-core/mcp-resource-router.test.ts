import { describe, expect, test } from "bun:test";
import type { ListMcpResourcesResponse, ReadMcpResourceResponse } from "@lume/shared";
import {
  createPluginAwareMcpResourceTools,
  replaceMcpResourceTools,
} from "./mcp-resource-router";
import { PLUGIN_MCP_WORKSPACE_SLUG } from "../plugins/plugin-mcp-bridge";
import type { ResolvedMcpServer } from "../plugins/capability-resolver";

const obsidianServer: ResolvedMcpServer = {
  pluginId: "obsidian-bridge",
  serverId: "obsidian-bridge",
  entry: { enabled: true, transport: "stdio", command: "node", args: ["mcp.js"] },
};

describe("plugin-aware MCP resource routing", () => {
  test("routes a plugin short serverId to the namespaced plugin MCP manager", async () => {
    const calls: unknown[] = [];
    const tools = createPluginAwareMcpResourceTools({
      workspaceSlug: "workspace-1",
      pluginServers: [obsidianServer],
      workspaceMcpManager: {
        async listResources(input): Promise<ListMcpResourcesResponse> {
          calls.push({ kind: "workspace-list", ...input });
          return { resources: [] };
        },
        async readResource(input): Promise<ReadMcpResourceResponse> {
          calls.push({ kind: "workspace-read", ...input });
          return { serverId: input.serverId, uri: input.uri, contents: [] };
        },
      },
      pluginMcpManager: {
        async listResources(input): Promise<ListMcpResourcesResponse> {
          calls.push({ kind: "plugin-list", ...input });
          return {
            resources: [{
              serverId: input.serverId ?? "obsidian-bridge:obsidian-bridge",
              serverName: "Obsidian",
              uri: "obsidian://vault/Inbox.md",
            }],
          };
        },
        async readResource(input): Promise<ReadMcpResourceResponse> {
          calls.push({ kind: "plugin-read", ...input });
          return { serverId: input.serverId, uri: input.uri, contents: [{ text: "note" }] };
        },
      },
    });

    const listTool = tools.find((tool) => tool.name === "ListMcpResourcesTool");
    const readTool = tools.find((tool) => tool.name === "ReadMcpResourceTool");

    const listResult = await listTool!.call(
      { serverId: "obsidian-bridge" },
      { cwd: "/tmp", toolUseId: "list-1" },
    );
    const readResult = await readTool!.call(
      { serverId: "obsidian-bridge", uri: "obsidian://vault/Inbox.md" },
      { cwd: "/tmp", toolUseId: "read-1" },
    );

    expect(calls).toEqual([
      {
        kind: "plugin-list",
        workspaceSlug: PLUGIN_MCP_WORKSPACE_SLUG,
        serverId: "obsidian-bridge:obsidian-bridge",
      },
      {
        kind: "plugin-read",
        workspaceSlug: PLUGIN_MCP_WORKSPACE_SLUG,
        serverId: "obsidian-bridge:obsidian-bridge",
        uri: "obsidian://vault/Inbox.md",
      },
    ]);
    expect(String(listResult.content)).toContain("obsidian://vault/Inbox.md");
    expect(String(readResult.content)).toContain("note");
  });

  test("combines workspace and plugin resources when no serverId is requested", async () => {
    const tools = createPluginAwareMcpResourceTools({
      workspaceSlug: "workspace-1",
      pluginServers: [obsidianServer],
      workspaceMcpManager: {
        async listResources(): Promise<ListMcpResourcesResponse> {
          return { resources: [{ serverId: "github", serverName: "GitHub", uri: "repo://issue/1" }] };
        },
        async readResource(input): Promise<ReadMcpResourceResponse> {
          return { serverId: input.serverId, uri: input.uri, contents: [] };
        },
      },
      pluginMcpManager: {
        async listResources(): Promise<ListMcpResourcesResponse> {
          return {
            resources: [{
              serverId: "obsidian-bridge:obsidian-bridge",
              serverName: "Obsidian",
              uri: "obsidian://vault/Inbox.md",
            }],
          };
        },
        async readResource(input): Promise<ReadMcpResourceResponse> {
          return { serverId: input.serverId, uri: input.uri, contents: [] };
        },
      },
    });

    const listTool = tools.find((tool) => tool.name === "ListMcpResourcesTool");
    const result = await listTool!.call({}, { cwd: "/tmp", toolUseId: "list-1" });

    expect(String(result.content)).toContain("repo://issue/1");
    expect(String(result.content)).toContain("obsidian://vault/Inbox.md");
  });

  test("replaces only fixed MCP resource tools", () => {
    const original = [
      { name: "mcp__github__search_issues" },
      { name: "ListMcpResourcesTool" },
      { name: "ReadMcpResourceTool" },
    ];
    const replacement = [
      { name: "ListMcpResourcesTool" },
      { name: "ReadMcpResourceTool" },
    ];

    expect(replaceMcpResourceTools(original as any, replacement as any).map((tool) => tool.name)).toEqual([
      "mcp__github__search_issues",
      "ListMcpResourcesTool",
      "ReadMcpResourceTool",
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import {
  mcpCallToolDiagnosticInputSchema,
  mcpListResourcesInputSchema,
  mcpReadResourceInputSchema,
  mcpStatusInputSchema,
  mcpTestServerInputSchema,
  workspaceMcpConfigInputSchema
} from "./schemas";

describe("MCP RPC schemas", () => {
  test("workspaceMcpConfigInputSchema accepts canonical streamable_http", () => {
    const parsed = workspaceMcpConfigInputSchema.parse({
      workspaceSlug: "demo",
      config: {
        servers: {
          remote: {
            transport: "streamable_http",
            url: "https://example.com/mcp",
            enabled: true
          }
        }
      }
    });

    expect(parsed.config.servers.remote?.transport).toBe("streamable_http");
  });

  test("workspaceMcpConfigInputSchema accepts disabled MCP tool names", () => {
    const parsed = workspaceMcpConfigInputSchema.parse({
      workspaceSlug: "demo",
      config: {
        servers: {
          remote: {
            transport: "streamable_http",
            url: "https://example.com/mcp",
            enabled: true,
            disabledTools: ["echo"]
          }
        }
      }
    });

    expect(parsed.config.servers.remote?.disabledTools).toEqual(["echo"]);
  });

  test("workspaceMcpConfigInputSchema accepts legacy http type", () => {
    const parsed = workspaceMcpConfigInputSchema.parse({
      workspaceSlug: "demo",
      config: {
        servers: {
          remote: {
            type: "http",
            url: "https://example.com/mcp",
            enabled: true
          }
        }
      }
    });

    expect(parsed.config.servers.remote?.type).toBe("http");
  });

  test("workspaceMcpConfigInputSchema rejects entries without transport or type", () => {
    expect(() =>
      workspaceMcpConfigInputSchema.parse({
        workspaceSlug: "demo",
        config: {
          servers: {
            remote: {
              url: "https://example.com/mcp",
              enabled: true
            }
          }
        }
      })
    ).toThrow();
  });

  test("workspaceMcpConfigInputSchema rejects stdio entries without command", () => {
    expect(() =>
      workspaceMcpConfigInputSchema.parse({
        workspaceSlug: "demo",
        config: {
          servers: {
            local: {
              transport: "stdio",
              enabled: true
            }
          }
        }
      })
    ).toThrow();
  });

  test("workspaceMcpConfigInputSchema rejects remote entries without url", () => {
    expect(() =>
      workspaceMcpConfigInputSchema.parse({
        workspaceSlug: "demo",
        config: {
          servers: {
            remote: {
              transport: "streamable_http",
              enabled: true
            },
            events: {
              transport: "sse",
              enabled: true
            }
          }
        }
      })
    ).toThrow();
  });

  test("mcpStatusInputSchema requires workspaceSlug", () => {
    expect(mcpStatusInputSchema.parse({ workspaceSlug: "demo" }).workspaceSlug).toBe("demo");
    expect(mcpStatusInputSchema.parse({ workspaceSlug: "demo", waitForConnections: false }).waitForConnections).toBe(false);
    expect(() => mcpStatusInputSchema.parse({})).toThrow();
  });

  test("mcpTestServerInputSchema requires workspaceSlug and serverId", () => {
    expect(mcpTestServerInputSchema.parse({ workspaceSlug: "demo", serverId: "github" }).serverId).toBe("github");
    expect(() => mcpTestServerInputSchema.parse({ workspaceSlug: "demo" })).toThrow();
  });

  test("mcpListResourcesInputSchema accepts optional serverId", () => {
    expect(mcpListResourcesInputSchema.parse({ workspaceSlug: "demo" }).serverId).toBeUndefined();
    expect(mcpListResourcesInputSchema.parse({ workspaceSlug: "demo", serverId: "github" }).serverId).toBe("github");
  });

  test("mcpReadResourceInputSchema requires workspaceSlug, serverId, and uri", () => {
    expect(
      mcpReadResourceInputSchema.parse({
        workspaceSlug: "demo",
        serverId: "github",
        uri: "file://a"
      }).uri
    ).toBe("file://a");
    expect(() => mcpReadResourceInputSchema.parse({ workspaceSlug: "demo", serverId: "github" })).toThrow();
  });

  test("mcpCallToolDiagnosticInputSchema requires object args", () => {
    expect(
      mcpCallToolDiagnosticInputSchema.parse({
        workspaceSlug: "demo",
        serverId: "github",
        originalToolName: "search",
        args: {}
      }).args
    ).toEqual({});
    expect(() =>
      mcpCallToolDiagnosticInputSchema.parse({
        workspaceSlug: "demo",
        serverId: "github",
        originalToolName: "search",
        args: []
      })
    ).toThrow();
  });
});

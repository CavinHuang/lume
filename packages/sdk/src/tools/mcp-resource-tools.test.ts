import { describe, expect, test } from "bun:test";
import type { MCPConnection } from "../mcp/client.js";
import {
  setMcpConnections,
  SubscribePollingTool,
  UnsubscribePollingTool,
} from "./mcp-resource-tools.js";

function fakeConnection(name: string, onRead?: (uri: string) => void): MCPConnection {
  return {
    name,
    status: "connected",
    enabled: true,
    config: {},
    tools: [],
    listResources: async () => [],
    readResource: async (uri: string) => {
      onRead?.(uri);
      return { contents: [] };
    },
    subscribeResource: async () => {},
    unsubscribeResource: async () => {},
    close: async () => {},
  } as MCPConnection;
}

async function callTool(tool: typeof SubscribePollingTool, input: Record<string, unknown>) {
  return tool.call(input, {} as never) as Promise<{ content: string; is_error?: boolean }>;
}

describe("SubscribePolling lifecycle (#228)", () => {
  test("setMcpConnections stops polling timers for removed servers", async () => {
    const reads: string[] = [];
    const conn = fakeConnection("server-a", (uri) => reads.push(uri));
    setMcpConnections([conn]);

    const result = await callTool(SubscribePollingTool, { server: "server-a", uri: "mem://x", interval_ms: 200 });
    expect(result.is_error).toBeUndefined();

    // swap in a table without server-a — the old timer must not survive it
    setMcpConnections([fakeConnection("server-b")]);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(reads).toHaveLength(0);
  });

  test("keeps polling while the server stays in the connection table", async () => {
    const reads: string[] = [];
    const conn = fakeConnection("server-a", (uri) => reads.push(uri));
    setMcpConnections([conn]);

    await callTool(SubscribePollingTool, { server: "server-a", uri: "mem://x", interval_ms: 200 });
    setMcpConnections([conn]); // refresh with the same server still present
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(reads.length).toBeGreaterThan(0);

    await callTool(UnsubscribePollingTool, { server: "server-a", uri: "mem://x" });
  });

  test("rejects subscriptions beyond the global cap", async () => {
    setMcpConnections([fakeConnection("cap-server")]);

    let last: { content: string; is_error?: boolean } | undefined;
    for (let i = 0; i < 60; i++) {
      last = await callTool(SubscribePollingTool, { server: "cap-server", uri: `mem://${i}` });
    }

    expect(last?.is_error).toBe(true);
    expect(last?.content).toContain("limit reached");

    // clean up whatever got registered so later tests start fresh
    for (let i = 0; i < 60; i++) {
      await callTool(UnsubscribePollingTool, { server: "cap-server", uri: `mem://${i}` });
    }
  });
});

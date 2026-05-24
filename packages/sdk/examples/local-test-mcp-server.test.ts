import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  LOCAL_TEST_MCP_RESOURCE_URI,
  buildLocalTestMcpConfig,
  startLocalMcpHttpServer
} from "./local-test-mcp-server.js";

const serverPath = fileURLToPath(new URL("./local-test-mcp-server.ts", import.meta.url));

async function withClient<T>(
  transport: Transport,
  run: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client({ name: "lume-local-mcp-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

async function expectLocalTestCapabilities(client: Client, transport: string): Promise<void> {
  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name)).toContain("echo");
  expect(tools.tools.map((tool) => tool.name)).toContain("get_server_info");

  const echoResult = await client.callTool({
    name: "echo",
    arguments: { message: "hello lume", repeat: 2 }
  }) as { content?: Array<{ type: string; text?: string }> };
  expect(echoResult.content?.[0]?.text).toContain("hello lume hello lume");

  const resources = await client.listResources();
  expect(resources.resources.map((resource) => resource.uri)).toContain(LOCAL_TEST_MCP_RESOURCE_URI);

  const resource = await client.readResource({ uri: LOCAL_TEST_MCP_RESOURCE_URI }) as {
    contents?: Array<{ text?: string }>;
  };
  expect(resource.contents?.[0]?.text).toContain(`"transport":"${transport}"`);
}

describe("local test MCP server", () => {
  test("prints importable config for stdio, SSE, and Streamable HTTP", () => {
    expect(buildLocalTestMcpConfig({
      command: "bun",
      scriptPath: "/repo/packages/sdk/examples/local-test-mcp-server.ts",
      host: "127.0.0.1",
      port: 39231
    })).toEqual({
      mcpServers: {
        "lume-test-stdio": {
          transport: "stdio",
          command: "bun",
          args: ["/repo/packages/sdk/examples/local-test-mcp-server.ts", "stdio"],
          enabled: true
        },
        "lume-test-sse": {
          transport: "sse",
          url: "http://127.0.0.1:39231/sse",
          enabled: true
        },
        "lume-test-http": {
          transport: "streamable_http",
          url: "http://127.0.0.1:39231/mcp",
          enabled: true
        }
      }
    });
  });

  test("stdio transport exposes the local test tools and resource", async () => {
    const transport = new StdioClientTransport({
      command: "bun",
      args: [serverPath, "stdio"],
      stderr: "pipe"
    });

    await withClient(transport, (client) => expectLocalTestCapabilities(client, "stdio"));
  });

  test("Streamable HTTP transport exposes the local test tools and resource", async () => {
    const service = await startLocalMcpHttpServer({
      host: "127.0.0.1",
      port: 0,
      transport: "streamable_http",
      log: false
    });

    try {
      const transport = new StreamableHTTPClientTransport(new URL("/mcp", service.url));
      await withClient(transport, (client) => expectLocalTestCapabilities(client, "streamable_http"));
    } finally {
      await service.close();
    }
  });

  test("legacy SSE transport exposes the local test tools and resource", async () => {
    const service = await startLocalMcpHttpServer({
      host: "127.0.0.1",
      port: 0,
      transport: "sse",
      log: false
    });

    try {
      const transport = new SSEClientTransport(new URL("/sse", service.url));
      await withClient(transport, (client) => expectLocalTestCapabilities(client, "sse"));
    } finally {
      await service.close();
    }
  });
});

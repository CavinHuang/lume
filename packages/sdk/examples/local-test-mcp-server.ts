import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export type LocalTestMcpTransport = "stdio" | "sse" | "streamable_http";
export type LocalTestHttpTransport = "sse" | "streamable_http" | "both";

export const DEFAULT_LOCAL_TEST_MCP_HOST = "127.0.0.1";
export const DEFAULT_LOCAL_TEST_MCP_PORT = 39231;
export const LOCAL_TEST_MCP_RESOURCE_URI = "lume-test://server/info";

export interface LocalTestMcpConfigInput {
  command?: string;
  scriptPath?: string;
  host?: string;
  port?: number;
}

export interface StartLocalMcpHttpServerOptions {
  host?: string;
  port?: number;
  transport?: LocalTestHttpTransport;
  log?: boolean;
}

export interface LocalMcpHttpService {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

type ManagedTransport = StreamableHTTPServerTransport | SSEServerTransport;

export function buildLocalTestMcpConfig(input: LocalTestMcpConfigInput = {}) {
  const command = input.command ?? "bun";
  const scriptPath = input.scriptPath ?? fileURLToPath(import.meta.url);
  const host = input.host ?? DEFAULT_LOCAL_TEST_MCP_HOST;
  const port = input.port ?? DEFAULT_LOCAL_TEST_MCP_PORT;
  const baseUrl = `http://${host}:${port}`;

  return {
    mcpServers: {
      "lume-test-stdio": {
        transport: "stdio",
        command,
        args: [scriptPath, "stdio"],
        enabled: true
      },
      "lume-test-sse": {
        transport: "sse",
        url: `${baseUrl}/sse`,
        enabled: true
      },
      "lume-test-http": {
        transport: "streamable_http",
        url: `${baseUrl}/mcp`,
        enabled: true
      }
    }
  } as const;
}

export function createLocalTestMcpServer(transport: LocalTestMcpTransport): McpServer {
  const startedAt = new Date().toISOString();
  const server = new McpServer({
    name: `lume-local-test-${transport}`,
    version: "1.0.0"
  });
  const echoInputSchema = {
    message: z.string().describe("Message to echo."),
    repeat: z.number().int().min(1).max(5).default(1).describe("How many times to repeat the message.")
  };

  server.registerTool(
    "echo",
    {
      description: "Echo a message so Lume can verify MCP tool calls.",
      inputSchema: echoInputSchema,
      annotations: { readOnlyHint: true }
    } as any,
    async ({ message, repeat }: { message: string; repeat: number }) => ({
      content: [{
        type: "text",
        text: `[${transport}] ${Array.from({ length: repeat }, () => message).join(" ")}`
      }]
    })
  );

  server.registerTool(
    "get_server_info",
    {
      description: "Return local MCP test server metadata.",
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      const info = buildServerInfo(transport, startedAt);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(info)
        }],
        structuredContent: info
      };
    }
  );

  server.registerResource(
    "server-info",
    LOCAL_TEST_MCP_RESOURCE_URI,
    {
      title: "Lume local MCP test server info",
      description: "Static metadata for checking MCP resource list/read support.",
      mimeType: "application/json"
    },
    async () => ({
      contents: [{
        uri: LOCAL_TEST_MCP_RESOURCE_URI,
        mimeType: "application/json",
        text: JSON.stringify(buildServerInfo(transport, startedAt))
      }]
    })
  );

  return server;
}

export async function startLocalMcpHttpServer(
  options: StartLocalMcpHttpServerOptions = {}
): Promise<LocalMcpHttpService> {
  const host = options.host ?? DEFAULT_LOCAL_TEST_MCP_HOST;
  const port = options.port ?? DEFAULT_LOCAL_TEST_MCP_PORT;
  const transportMode = options.transport ?? "both";
  const log = options.log ?? true;
  const transports = new Map<string, ManagedTransport>();

  const httpServer = createServer(async (req, res) => {
    addCorsHeaders(res);
    try {
      if (req.method === "OPTIONS") {
        sendNoContent(res);
        return;
      }

      const url = requestUrl(req, host, port);
      if (url.pathname === "/health") {
        sendJson(res, 200, { ok: true, transport: transportMode });
        return;
      }
      if (url.pathname === "/config") {
        sendJson(res, 200, buildLocalTestMcpConfig({ host, port: actualPort(httpServer) }));
        return;
      }
      if (url.pathname === "/mcp" && transportMode !== "sse") {
        await handleStreamableHttpRequest(req, res, transports);
        return;
      }
      if (url.pathname === "/sse" && req.method === "GET" && transportMode !== "streamable_http") {
        await handleSseConnect(res, transports);
        return;
      }
      if (url.pathname === "/messages" && req.method === "POST" && transportMode !== "streamable_http") {
        await handleSseMessage(req, res, url, transports);
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: message });
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const actual = actualPort(httpServer);
  if (log) {
    console.error(`Lume local MCP test server listening at http://${host}:${actual}`);
    if (transportMode !== "sse") {
      console.error(`Streamable HTTP: http://${host}:${actual}/mcp`);
    }
    if (transportMode !== "streamable_http") {
      console.error(`SSE: http://${host}:${actual}/sse`);
    }
  }

  return {
    host,
    port: actual,
    url: `http://${host}:${actual}`,
    async close() {
      for (const transport of transports.values()) {
        await transport.close().catch(() => undefined);
      }
      transports.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  };
}

async function handleStreamableHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transports: Map<string, ManagedTransport>
): Promise<void> {
  const sessionId = headerValue(req, "mcp-session-id");
  let transport: StreamableHTTPServerTransport | undefined;
  let parsedBody: unknown;

  if (req.method === "POST") {
    parsedBody = await readJsonBody(req);
  }

  if (sessionId) {
    const existing = transports.get(sessionId);
    if (existing instanceof StreamableHTTPServerTransport) {
      transport = existing;
    } else {
      sendJson(res, 400, jsonRpcError("Session exists but uses a different transport protocol"));
      return;
    }
  } else if (req.method === "POST" && isInitializeRequest(parsedBody)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (nextSessionId) => {
        if (transport) {
          transports.set(nextSessionId, transport);
        }
      }
    });
    transport.onclose = () => {
      const nextSessionId = transport?.sessionId;
      if (nextSessionId) {
        transports.delete(nextSessionId);
      }
    };
    await createLocalTestMcpServer("streamable_http").connect(transport);
  } else {
    sendJson(res, 400, jsonRpcError("No valid MCP session id or initialize request"));
    return;
  }

  await transport.handleRequest(req, res, parsedBody);
}

async function handleSseConnect(
  res: ServerResponse,
  transports: Map<string, ManagedTransport>
): Promise<void> {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);
  res.on("close", () => {
    transports.delete(transport.sessionId);
  });
  await createLocalTestMcpServer("sse").connect(transport);
}

async function handleSseMessage(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transports: Map<string, ManagedTransport>
): Promise<void> {
  const sessionId = url.searchParams.get("sessionId");
  const transport = sessionId ? transports.get(sessionId) : undefined;
  const parsedBody = await readJsonBody(req);
  if (transport instanceof SSEServerTransport) {
    await transport.handlePostMessage(req, res, parsedBody);
    return;
  }
  sendJson(res, 400, { error: "No SSE transport found for sessionId" });
}

async function runStdio(): Promise<void> {
  const server = createLocalTestMcpServer("stdio");
  await server.connect(new StdioServerTransport());
}

function buildServerInfo(transport: LocalTestMcpTransport, startedAt: string) {
  return {
    name: "lume-local-test-mcp",
    version: "1.0.0",
    transport,
    startedAt,
    tools: ["echo", "get_server_info"],
    resources: [LOCAL_TEST_MCP_RESOURCE_URI],
    protocols: ["stdio", "sse", "streamable_http"]
  };
}

function requestUrl(req: IncomingMessage, host: string, port: number): URL {
  const reqHost = req.headers.host ?? `${host}:${port}`;
  return new URL(req.url ?? "/", `http://${reqHost}`);
}

function actualPort(server: HttpServer): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    return DEFAULT_LOCAL_TEST_MCP_PORT;
  }
  return address.port;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const text = Buffer.concat(chunks).toString("utf-8").trim();
  return text ? JSON.parse(text) : undefined;
}

function addCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Last-Event-ID");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function jsonRpcError(message: string) {
  return {
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message
    },
    id: null
  };
}

function readCliOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) {
    return args[index + 1];
  }
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function normalizeCliTransport(value: string | undefined): LocalTestMcpTransport | "config" {
  const normalized = (value ?? "streamable_http").trim().toLowerCase();
  if (normalized === "config" || normalized === "print-config") return "config";
  if (normalized === "stdio") return "stdio";
  if (normalized === "sse") return "sse";
  if (normalized === "http" || normalized === "streamable-http" || normalized === "streamable_http") {
    return "streamable_http";
  }
  throw new Error(`Unsupported transport: ${value}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const transport = normalizeCliTransport(readCliOption(args, "--transport") ?? args[0]);
  const host = readCliOption(args, "--host") ?? process.env.LUME_MCP_TEST_HOST ?? DEFAULT_LOCAL_TEST_MCP_HOST;
  const port = Number(readCliOption(args, "--port") ?? process.env.LUME_MCP_TEST_PORT ?? DEFAULT_LOCAL_TEST_MCP_PORT);

  if (transport === "config") {
    console.log(JSON.stringify(buildLocalTestMcpConfig({ host, port }), null, 2));
    return;
  }

  if (transport === "stdio") {
    await runStdio();
    return;
  }

  const service = await startLocalMcpHttpServer({ host, port, transport });
  const close = async () => {
    await service.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

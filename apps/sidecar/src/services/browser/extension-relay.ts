import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const DEFAULT_PORT = 18792;

function resolveRelayPort(defaultPort = DEFAULT_PORT): number {
  const raw = process.env.LUME_BROWSER_RELAY_PORT?.trim();
  if (!raw) return defaultPort;
  const port = Number.parseInt(raw, 10);
  return Number.isFinite(port) && port > 0 && port <= 65535 ? port : defaultPort;
}

type AttachedTab = {
  sessionId: string;
  targetId?: string;
  tabId: number;
  url?: string;
  title?: string;
};

export interface RelayStatus {
  running: boolean;
  port: number | null;
  connected: boolean;
  connectionCount: number;
  tabs: AttachedTab[];
  tokenRequired: boolean;
  diagnostics?: {
    lastRejectReason: string;
    lastCloseReason: string;
  };
}

let server: ReturnType<typeof createServer> | null = null;
let wss: WebSocketServer | null = null;
const extensionClients = new Set<WebSocket>();
const attachedTabs = new Map<string, AttachedTab>();
const sessionOwners = new Map<string, WebSocket>();
const pendingCommands = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let cmdId = 1;
let currentRelayToken: string | null = null;
let lastRejectReason = "";
let lastCloseReason = "";

function isLoopbackRemote(addr: string | undefined): boolean {
  // 在部分运行时里 remoteAddress 可能缺失；此处放宽为可通过，并在 diagnostics 保留信息。
  if (!addr) return true;
  return (
    addr === "127.0.0.1"
    || addr === "::1"
    || addr === "::ffff:127.0.0.1"
    || addr.startsWith("127.0.0.1")
    || addr.startsWith("::ffff:127.0.0.1")
  );
}

function isExtensionOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return origin.startsWith("chrome-extension://");
}

function resolveRelayToken(): string | null {
  const raw = process.env.LUME_BROWSER_RELAY_TOKEN?.trim();
  return raw ? raw : null;
}

function requestToken(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const token = url.searchParams.get("token");
  return token?.trim() ? token.trim() : null;
}

export function isRelayConnected(): boolean {
  return extensionClients.size > 0;
}

export function getAttachedTabs(): AttachedTab[] {
  return [...attachedTabs.values()];
}

export function getRelayStatus(): RelayStatus {
  const addr = server?.address();
  const actualPort = addr && typeof addr === "object" ? addr.port : null;
  return {
    running: Boolean(server),
    port: actualPort,
    connected: isRelayConnected(),
    connectionCount: extensionClients.size,
    tabs: getAttachedTabs(),
    tokenRequired: Boolean(currentRelayToken),
    diagnostics: {
      lastRejectReason,
      lastCloseReason
    }
  };
}

export async function startRelayServer(port = resolveRelayPort()): Promise<{ port: number }> {
  if (server) {
    const existing = getRelayStatus().port;
    return { port: existing ?? port };
  }
  currentRelayToken = resolveRelayToken();

  const nextServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    if (path === "/extension/status") {
      const status = getRelayStatus();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          running: status.running,
          connected: status.connected,
          connectionCount: status.connectionCount,
          tabs: status.tabs,
          port: status.port,
          tokenRequired: status.tokenRequired,
          diagnostics: status.diagnostics
        })
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Lume Relay OK");
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const handleListening = () => {
        nextServer.off("error", handleError);
        resolve();
      };
      const handleError = (error: Error & { code?: string }) => {
        nextServer.off("listening", handleListening);
        reject(error);
      };

      nextServer.once("listening", handleListening);
      nextServer.once("error", handleError);
      nextServer.listen(port, "127.0.0.1");
    });
  } catch (error) {
    nextServer.close();
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "EADDRINUSE") {
      throw new Error(`浏览器 Relay 端口 ${port} 已被占用，请关闭占用进程或设置 LUME_BROWSER_RELAY_PORT`);
    }
    throw new Error(`浏览器 Relay 启动失败: ${message}`);
  }

  const nextWss = new WebSocketServer({ server: nextServer, path: "/extension" });
  nextWss.on("connection", handleExtensionConnection);
  server = nextServer;
  wss = nextWss;
  const addr = server.address() as AddressInfo | null;
  const actualPort = addr && typeof addr === "object" ? addr.port : port;
  return { port: actualPort };
}

export async function stopRelayServer(): Promise<void> {
  for (const ws of extensionClients) {
    ws.close();
  }
  extensionClients.clear();
  wss?.close();
  wss = null;
  server?.close();
  server = null;
  attachedTabs.clear();
  sessionOwners.clear();
  currentRelayToken = null;
}

function handleExtensionConnection(ws: WebSocket, req: IncomingMessage) {
  const remoteAddress = req.socket.remoteAddress;
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (!isLoopbackRemote(remoteAddress) || !isExtensionOrigin(origin)) {
    lastRejectReason = `forbidden: remote=${remoteAddress ?? "unknown"} origin=${origin ?? "n/a"}`;
    console.error(`[浏览器 Relay] 拒绝连接 ${lastRejectReason}`);
    ws.close(1008, "forbidden");
    return;
  }
  if (currentRelayToken && requestToken(req) !== currentRelayToken) {
    lastRejectReason = "forbidden: token mismatch";
    console.error(`[浏览器 Relay] 拒绝连接 ${lastRejectReason}`);
    ws.close(1008, "forbidden");
    return;
  }
  lastRejectReason = "";

  extensionClients.add(ws);
  console.error(
    `[浏览器 Relay] extension 已连接 remote=${remoteAddress ?? "unknown"} origin=${origin ?? "n/a"} clients=${extensionClients.size}`
  );

  ws.on("message", (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      handleExtensionMessage(ws, msg);
    } catch {}
  });

  ws.on("close", (code, reason) => {
    extensionClients.delete(ws);
    for (const [sessionId, owner] of sessionOwners.entries()) {
      if (owner === ws) {
        sessionOwners.delete(sessionId);
        attachedTabs.delete(sessionId);
      }
    }
    lastCloseReason = `code=${code} reason=${String(reason || "")}`;
    console.error(
      `[浏览器 Relay] extension 已断开 code=${code} reason=${String(reason || "")} clients=${extensionClients.size}`
    );
  });
}

function handleExtensionMessage(ws: WebSocket, msg: Record<string, unknown>) {
  if (msg.method === "tabAttached") {
    const p = msg.params as AttachedTab;
    attachedTabs.set(p.sessionId, p);
    sessionOwners.set(p.sessionId, ws);
    return;
  }
  if (msg.method === "tabDetached") {
    const p = msg.params as { sessionId: string };
    attachedTabs.delete(p.sessionId);
    sessionOwners.delete(p.sessionId);
    return;
  }
  if (msg.method === "pong") return;

  // CDP response
  if (typeof msg.id === "number") {
    const p = pendingCommands.get(msg.id);
    if (p) {
      pendingCommands.delete(msg.id);
      msg.error ? p.reject(new Error(String(msg.error))) : p.resolve(msg.result);
    }
  }
}

export async function sendCDPCommand(method: string, params?: unknown): Promise<unknown> {
  if (extensionClients.size === 0) {
    throw new Error("Extension not connected");
  }
  const targetParam = params as { targetId?: string; sessionId?: string } | undefined;
  let selectedTab: AttachedTab | undefined;
  if (targetParam?.sessionId) {
    selectedTab = attachedTabs.get(targetParam.sessionId);
  } else if (targetParam?.targetId) {
    selectedTab = [...attachedTabs.values()].find((tab) => tab.targetId === targetParam.targetId);
  } else {
    [selectedTab] = attachedTabs.values();
  }
  const targetSessionId = selectedTab?.sessionId;
  const targetWs = targetSessionId ? sessionOwners.get(targetSessionId) : undefined;
  const fallbackWs = targetWs ?? [...extensionClients][0];
  if (!fallbackWs || fallbackWs.readyState !== WebSocket.OPEN) {
    throw new Error("Extension not connected");
  }
  const id = cmdId++;
  return new Promise((resolve, reject) => {
    pendingCommands.set(id, { resolve, reject });
    fallbackWs.send(
      JSON.stringify({
        id,
        method: "forwardCDPCommand",
        params: { method, params, sessionId: targetSessionId }
      })
    );
    setTimeout(() => {
      if (pendingCommands.has(id)) {
        pendingCommands.delete(id);
        reject(new Error("CDP command timeout"));
      }
    }, 30000);
  });
}

import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const DEFAULT_PORT = 18792;

type AttachedTab = {
  sessionId: string;
  tabId: number;
  url?: string;
  title?: string;
};

let server: ReturnType<typeof createServer> | null = null;
let wss: WebSocketServer | null = null;
let extensionWs: WebSocket | null = null;
const attachedTabs = new Map<string, AttachedTab>();
const pendingCommands = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let cmdId = 1;

export function isRelayConnected(): boolean {
  return extensionWs?.readyState === WebSocket.OPEN;
}

export function getAttachedTabs(): AttachedTab[] {
  return [...attachedTabs.values()];
}

export async function startRelayServer(port = DEFAULT_PORT): Promise<{ port: number }> {
  if (server) return { port };

  server = createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Lume Relay OK");
  });

  wss = new WebSocketServer({ server, path: "/extension" });
  wss.on("connection", handleExtensionConnection);

  await new Promise<void>((resolve) => server!.listen(port, "127.0.0.1", resolve));
  return { port };
}

export async function stopRelayServer(): Promise<void> {
  extensionWs?.close();
  extensionWs = null;
  wss?.close();
  wss = null;
  server?.close();
  server = null;
  attachedTabs.clear();
}

function handleExtensionConnection(ws: WebSocket) {
  if (extensionWs) extensionWs.close();
  extensionWs = ws;

  ws.on("message", (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      handleExtensionMessage(msg);
    } catch {}
  });

  ws.on("close", () => {
    if (extensionWs === ws) {
      extensionWs = null;
      attachedTabs.clear();
    }
  });
}

function handleExtensionMessage(msg: Record<string, unknown>) {
  if (msg.method === "tabAttached") {
    const p = msg.params as AttachedTab;
    attachedTabs.set(p.sessionId, p);
    return;
  }
  if (msg.method === "tabDetached") {
    const p = msg.params as { sessionId: string };
    attachedTabs.delete(p.sessionId);
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
  if (!extensionWs || extensionWs.readyState !== WebSocket.OPEN) {
    throw new Error("Extension not connected");
  }
  const id = cmdId++;
  return new Promise((resolve, reject) => {
    pendingCommands.set(id, { resolve, reject });
    extensionWs!.send(JSON.stringify({ id, method: "forwardCDPCommand", params: { method, params } }));
    setTimeout(() => {
      if (pendingCommands.has(id)) {
        pendingCommands.delete(id);
        reject(new Error("CDP command timeout"));
      }
    }, 30000);
  });
}

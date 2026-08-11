import type { LinkRuntimeMode, LinkRuntimePhase } from "@lume/shared";
import { McpClientManager } from "@lume/agent-sdk";
import { createLogger } from "../infra/logger";

type LinkRuntimeBootstrap = { mode?: LinkRuntimeMode; phase: LinkRuntimePhase; origin?: string; adminToken?: string; runtimeToken?: string };
type BootstrapState = { mode?: LinkRuntimeMode; phase: LinkRuntimePhase; origin?: string; adminToken?: Buffer; runtimeToken?: Buffer };

let bootstrap: BootstrapState = { phase: "disabled" };
const log = createLogger("link-client");
const LINK_RUNTIME_PHASES = new Set<LinkRuntimePhase>([
  "disabled", "starting", "online", "stopping", "offline", "crashed", "port_conflict", "incompatible",
]);

export function installLinkRuntimeBootstrap(value: unknown): void {
  clearSecrets();
  if (!value || typeof value !== "object") {
    bootstrap = { phase: "offline" };
    return;
  }
  const input = value as LinkRuntimeBootstrap;
  if (!LINK_RUNTIME_PHASES.has(input.phase)) {
    bootstrap = { phase: "offline" };
    throw new Error("invalid_link_bootstrap");
  }
  if (input.phase !== "online") {
    void getLinkMcpClient().disconnect(LINK_MCP_SERVER_ID).catch(() => { /* best-effort cleanup on phase leave */ });
    bootstrap = { phase: input.phase };
    return;
  }
  const mode = input.mode ?? "local";
  const originValid = mode === "local" ? isEmbeddedOrigin(input.origin) : mode === "remote" && isRemoteOrigin(input.origin);
  if (!originValid || (mode === "local" && (!input.adminToken || !input.runtimeToken))) {
    bootstrap = { phase: "offline" };
    throw new Error("invalid_link_bootstrap");
  }
  bootstrap = {
    phase: "online",
    mode,
    origin: input.origin,
    ...(input.adminToken ? { adminToken: Buffer.from(input.adminToken) } : {}),
    ...(input.runtimeToken ? { runtimeToken: Buffer.from(input.runtimeToken) } : {}),
  };
  getLinkMcpClient().register(LINK_MCP_SERVER_ID, {
    enabled: true,
    transport: "streamable_http",
    url: `${input.origin}/mcp`,
    ...(input.runtimeToken ? { headers: { authorization: `Bearer ${input.runtimeToken}` } } : {}),
  });
  void getLinkMcpClient().connect(LINK_MCP_SERVER_ID).catch((error) => {
    log.warn("MCP 连接失败", { error: error instanceof Error ? error.message : String(error) });
  });
}

export function getLinkRuntimePhase(): LinkRuntimePhase {
  return bootstrap.phase;
}

export function getLinkRuntimeOrigin(): string | undefined {
  return bootstrap.phase === "online" ? bootstrap.origin : undefined;
}

export function isLinkRuntimeOnline(): boolean {
  return bootstrap.phase === "online";
}

export async function linkAdminRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return linkRequest<T>(path, init);
}

async function linkRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (bootstrap.phase !== "online" || !bootstrap.origin) throw new Error("link_runtime_offline");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const onAbort = () => controller.abort();
  init.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const url = new URL(path, bootstrap.origin);
    if (url.origin !== bootstrap.origin || !url.pathname.startsWith("/api/") || url.username || url.password || url.hash) {
      throw new Error("invalid_link_request_path");
    }
    const headers = new Headers(init.headers);
    if (init.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (bootstrap.adminToken) headers.set("authorization", `Bearer ${bootstrap.adminToken.toString()}`);
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
      headers,
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || body?.success === false) {
      const adminError = body?.error && typeof body.error === "object" ? body.error as Record<string, unknown> : undefined;
      throw new LinkApiError(
        typeof body?.errorCode === "string" ? body.errorCode : typeof adminError?.code === "string" ? adminError.code : `link_http_${response.status}`,
        typeof body?.message === "string" ? body.message : typeof adminError?.message === "string" ? adminError.message : "OpenConnector request failed",
      );
    }
    return body as T;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onAbort);
  }
}

export class LinkApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function isEmbeddedOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.protocol === "http:"
      && url.hostname === "127.0.0.1"
      && url.pathname === "/"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && Number.isInteger(port)
      && port >= 49152
      && port <= 65535;
  } catch {
    return false;
  }
}

function isRemoteOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const loopback = isLoopbackHostname(url.hostname);
    return (url.protocol === "https:" || (url.protocol === "http:" && loopback))
      && url.origin === value
      && url.pathname === "/"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function clearSecrets(): void {
  bootstrap.adminToken?.fill(0);
  bootstrap.runtimeToken?.fill(0);
}

export type McpLinkPayload =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };

export function extractMcpPayload(result: unknown): McpLinkPayload {
  const r = result as { structuredContent?: unknown; text?: unknown; content?: Array<{ text?: string }> };
  if (r && typeof r.structuredContent === "object" && r.structuredContent !== null) {
    const p = r.structuredContent as McpLinkPayload;
    if (p && (p.ok === true || p.ok === false)) return p;
  }
  // Production path: McpClientManager.callTool returns a normalized McpCallResult whose
  // original `content` blocks are merged into a top-level `text` string. Parse it first.
  const topText = r?.text;
  if (typeof topText === "string") {
    try {
      const parsed = JSON.parse(topText) as McpLinkPayload;
      if (parsed && (parsed.ok === true || parsed.ok === false)) return parsed;
    } catch { /* fall through */ }
  }
  // Defensive path: raw MCP result shape with a `content[]` array (kept for callers that
  // bypass McpClientManager normalization).
  const contentText = r?.content?.[0]?.text;
  if (typeof contentText === "string") {
    try {
      const parsed = JSON.parse(contentText) as McpLinkPayload;
      if (parsed && (parsed.ok === true || parsed.ok === false)) return parsed;
    } catch { /* fall through */ }
  }
  return { ok: false, error: { code: "link_mcp_invalid_payload", message: "OpenConnector MCP returned an incompatible payload." } };
}

const LINK_MCP_SERVER_ID = "openconnector";
let mcpClient: McpClientManager | null = null;

export function getLinkMcpClient(): McpClientManager {
  if (!mcpClient) mcpClient = new McpClientManager();
  return mcpClient;
}

export async function callLinkMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<McpLinkPayload> {
  const client = getLinkMcpClient();
  await client.ensureConnected(LINK_MCP_SERVER_ID);
  const result = await client.callTool(LINK_MCP_SERVER_ID, toolName, args, signal ? { signal } : {});
  return extractMcpPayload(result);
}

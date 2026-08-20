export type McpTransportType = "stdio" | "streamable_http" | "sse";
export type LegacyMcpTransportType = "stdio" | "http" | "sse";
export type McpPublicStatus = "disconnected" | "connecting" | "connected" | "error" | "auth_needed";

export interface McpServerEntry {
  name?: string;
  enabled: boolean;
  transport?: McpTransportType;
  type?: McpTransportType | LegacyMcpTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabledTools?: string[];
}

export interface WorkspaceMcpConfig {
  servers: Record<string, McpServerEntry>;
}

export interface McpToolDetail {
  name: string;
  originalName: string;
  wrapperName: string;
  description?: string;
  inputSchema?: unknown;
  serverId: string;
  serverName: string;
}

export interface McpServerStatus {
  serverId: string;
  name: string;
  transport: McpTransportType;
  enabled: boolean;
  status: McpPublicStatus;
  tools: string[];
  toolDetails: McpToolDetail[];
  error?: { code: string; message: string };
  lastConnectedAt?: number;
  lastCheckedAt?: number;
}

export interface McpResourceSummary {
  serverId: string;
  serverName: string;
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface GetMcpStatusRequest {
  workspaceSlug: string;
  waitForConnections?: boolean;
}

export interface GetMcpStatusResponse {
  servers: McpServerStatus[];
}

export interface TestMcpServerRequest {
  workspaceSlug: string;
  serverId: string;
}

export interface TestMcpServerResponse {
  server: McpServerStatus;
}

export interface ListMcpResourcesRequest {
  workspaceSlug: string;
  serverId?: string;
}

export interface ListMcpResourcesResponse {
  resources: McpResourceSummary[];
  errors?: Array<{ serverId: string; code: string; message: string }>;
}

export interface ReadMcpResourceRequest {
  workspaceSlug: string;
  serverId: string;
  uri: string;
}

export interface ReadMcpResourceResponse {
  serverId: string;
  uri: string;
  contents: unknown[];
}

export interface CallMcpToolDiagnosticRequest {
  workspaceSlug: string;
  serverId: string;
  originalToolName: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
}

export interface CallMcpToolDiagnosticResponse {
  serverId: string;
  originalToolName: string;
  text?: string;
  structuredContent?: unknown;
  isError?: boolean;
  truncated?: boolean;
  error?: { code: string; message: string };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      record[key] = entry;
    }
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const list = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return list.length > 0 ? list : undefined;
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(6, "0").slice(0, 6);
}

export function normalizeMcpTransport(entry: unknown): McpTransportType | undefined {
  if (!isPlainObject(entry)) {
    return undefined;
  }
  const candidate = typeof entry.transport === "string" ? entry.transport : entry.type;
  if (candidate === "stdio" || candidate === "sse" || candidate === "streamable_http") {
    return candidate;
  }
  if (candidate === "http") {
    return "streamable_http";
  }
  return undefined;
}

export function normalizeMcpServerId(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || null;
}

export function normalizeMcpToolName(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || null;
}

export function buildMcpToolWrapperName(
  serverId: string,
  originalToolName: string,
  takenNames: ReadonlySet<string> = new Set()
): string {
  const serverNamespace = normalizeMcpServerId(serverId) ?? "server";
  const toolNamespace = normalizeMcpToolName(originalToolName) ?? "tool";
  const base = `mcp__${serverNamespace}__${toolNamespace}`;
  if (!takenNames.has(base)) {
    return base;
  }
  return `${base}_${shortHash(`${serverNamespace}\0${originalToolName}`)}`;
}

export function parseMcpImportPayload(value: unknown): WorkspaceMcpConfig {
  if (!isPlainObject(value)) {
    return { servers: {} };
  }
  const root = isPlainObject(value.mcpServers) ? value.mcpServers : value;
  const servers: WorkspaceMcpConfig["servers"] = {};

  for (const [rawId, rawEntry] of Object.entries(root)) {
    const serverId = normalizeMcpServerId(rawId);
    if (!serverId || !isPlainObject(rawEntry)) {
      continue;
    }
    // "__proto__" hits the prototype setter instead of creating an own entry;
    // normalized collisions would silently overwrite the earlier import
    if (serverId === "__proto__" || serverId === "constructor" || serverId === "prototype") {
      continue;
    }
    if (Object.hasOwn(servers, serverId)) {
      continue;
    }

    const inferredTransport = normalizeMcpTransport(rawEntry)
      ?? (typeof rawEntry.url === "string" ? "streamable_http" : undefined)
      ?? (typeof rawEntry.command === "string" ? "stdio" : undefined);
    if (!inferredTransport) {
      continue;
    }

    const command = typeof rawEntry.command === "string" ? rawEntry.command : undefined;
    const url = typeof rawEntry.url === "string" ? rawEntry.url : undefined;
    if (inferredTransport === "stdio" && !command) {
      continue;
    }
    if ((inferredTransport === "streamable_http" || inferredTransport === "sse") && !url) {
      continue;
    }

    const args = stringList(rawEntry.args);
    const env = stringRecord(rawEntry.env);
    const headers = stringRecord(rawEntry.headers);
    const disabledTools = stringList(rawEntry.disabledTools);

    servers[serverId] = {
      ...(typeof rawEntry.name === "string" ? { name: rawEntry.name } : {}),
      enabled: typeof rawEntry.enabled === "boolean" ? rawEntry.enabled : true,
      transport: inferredTransport,
      ...(command ? { command } : {}),
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      ...(url ? { url } : {}),
      ...(headers ? { headers } : {}),
      ...(disabledTools ? { disabledTools } : {})
    };
  }

  return { servers };
}

export function maskMcpSecrets<T extends Record<string, unknown>>(record: T): T {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    masked[key] = /authorization|cookie|api[-_]?key|token|secret|password/i.test(key)
      ? "********"
      : value;
  }
  return masked as T;
}

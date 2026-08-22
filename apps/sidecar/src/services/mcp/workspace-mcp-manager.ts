import {
  McpClientManager,
  type ToolDefinition,
  type McpCallResult,
  type McpClientServerStatus,
  type McpListResourcesResult,
  type McpReadResourceResult,
  type NormalizedMcpServerConfig,
  type SandboxSettings
} from "@lume/agent-sdk";
import {
  maskMcpSecrets,
  normalizeMcpTransport,
  type CallMcpToolDiagnosticRequest,
  type CallMcpToolDiagnosticResponse,
  type ListMcpResourcesResponse,
  type McpResourceSummary,
  type McpServerEntry,
  type McpServerStatus,
  type ReadMcpResourceResponse,
  type WorkspaceMcpConfig
} from "@lume/shared";
import {
  createWorkspaceMcpConfigTool,
  createWorkspaceMcpResourceTools,
  createWorkspaceMcpToolDefinitions
} from "../agent-runtime/tools/mcp/create-mcp-tools";
import type { ToolRuntimeDiagnostic } from "../agent-runtime/tools/tool-runtime";
import { getWorkspaceMcpConfig } from "../agent/agent-workspace-manager";
import { createDiagnosticLogSummary, createLogger, type Logger } from "../infra/logger";

export interface WorkspaceSdkMcpManager {
  sync(configs: Record<string, NormalizedMcpServerConfig>): void;
  connect?(serverId: string): Promise<void>;
  ensureConnected?(serverId: string): Promise<void>;
  disconnect(serverId: string): Promise<void>;
  dispose(): Promise<void>;
  getStatus(): Record<string, McpClientServerStatus>;
  getTools(serverId?: string): unknown[];
  callTool(
    serverId: string,
    originalToolName: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<McpCallResult>;
  listResources(serverId?: string): Promise<McpListResourcesResult>;
  readResource(serverId: string, uri: string): Promise<McpReadResourceResult>;
}

/** Decision returned by an MCP pre-connect authorization gate (§8.1) or the sensitive-gate. */
export interface McpGateDecision {
  decision: "allow" | "block";
  reason?: string;
}

export interface WorkspaceMcpManagerOptions {
  readConfig?: (workspaceSlug: string) => WorkspaceMcpConfig;
  sdkManagerFactory?: () => WorkspaceSdkMcpManager;
  logger?: Pick<Logger, "warn" | "error" | "info">;
  /** Optional pre-connect authorization (e.g. plugin §8.1 MCP start gate). Undefined = no gate (workspace singleton). */
  authorizeConnect?: (serverId: string) => Promise<McpGateDecision>;
  /** Optional process sandbox for stdio servers owned by this manager. */
  stdioSandbox?: SandboxSettings;
  stdioCwd?: string;
}

export interface WorkspaceMcpRuntimeTools {
  tools: ToolDefinition[];
  diagnostics: ToolRuntimeDiagnostic[];
}

export interface CreateRuntimeToolsOptions {
  /** Include the fixed-name management tools (McpConfigTool/ListMcpResourcesTool/ReadMcpResourceTool). Default true (workspace). Plugin pool sets false to avoid collision. */
  includeManagementTools?: boolean;
  /** Optional per-server runtime metadata stamp (e.g. pluginId). Keyed by serverId. */
  toolMetadataProvider?: (serverId: string) => Record<string, unknown> | undefined;
}

interface WorkspaceState {
  sdk: WorkspaceSdkMcpManager;
  knownServerIds: Set<string>;
}

interface SyncWorkspaceOptions {
  waitForConnections?: boolean;
}

class PublicMcpError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PublicMcpError";
    this.code = code;
  }
}

const singletonLogger = createLogger("workspace-mcp-manager");
let singleton: WorkspaceMcpManager | null = null;

export function getWorkspaceMcpManager(): WorkspaceMcpManager {
  if (!singleton) {
    singleton = new WorkspaceMcpManager();
  }
  return singleton;
}

export function setWorkspaceMcpManagerForTesting(manager: WorkspaceMcpManager | null): void {
  singleton = manager;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function serverName(serverId: string, entry: McpServerEntry): string {
  return entry.name?.trim() || serverId;
}

function collectSecretValues(entry: McpServerEntry): string[] {
  const secrets: string[] = [];
  for (const record of [entry.env, entry.headers]) {
    if (!record) continue;
    const masked = maskMcpSecrets(record);
    for (const [key, value] of Object.entries(record)) {
      if (masked[key] === "********" && value.trim().length > 0) {
        secrets.push(value);
      }
    }
  }
  return secrets;
}

function redactMessage(message: string, entry?: McpServerEntry): string {
  if (!entry) {
    return message;
  }
  return collectSecretValues(entry).reduce((current, secret) => current.split(secret).join("********"), message);
}

function errorCodeFromUnknown(error: unknown): string | undefined {
  return typeof (error as { code?: unknown } | undefined)?.code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function errorMessageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mapPublicError(error: unknown, entry?: McpServerEntry): { code: string; message: string } {
  const sdkCode = errorCodeFromUnknown(error);
  const message = redactMessage(errorMessageFromUnknown(error), entry);
  if (sdkCode === "auth_error" || /401|403|unauthorized|forbidden|auth|token|api key/i.test(message)) {
    return { code: "auth_needed", message };
  }
  if (sdkCode === "transport_error") {
    return {
      code: normalizeMcpTransport(entry) === "stdio" ? "spawn_failed" : "connection_failed",
      message
    };
  }
  return { code: sdkCode ?? "mcp_error", message };
}

function isUnsupportedResourceListError(error: unknown): boolean {
  return /method not found|-32601/i.test(errorMessageFromUnknown(error));
}

function toNormalizedConfigs(
  config: WorkspaceMcpConfig,
  stdio?: { sandbox?: SandboxSettings; cwd?: string }
): Record<string, NormalizedMcpServerConfig> {
  const configs: Record<string, NormalizedMcpServerConfig> = {};
  for (const [serverId, entry] of Object.entries(config.servers ?? {})) {
    const transport = normalizeMcpTransport(entry);
    if (!transport) {
      continue;
    }
    if (transport === "stdio" && !isNonEmptyString(entry.command)) {
      continue;
    }
    if ((transport === "streamable_http" || transport === "sse") && !isNonEmptyString(entry.url)) {
      continue;
    }
    configs[serverId] = {
      name: serverName(serverId, entry),
      enabled: entry.enabled,
      transport,
      ...(entry.command ? { command: entry.command } : {}),
      ...(entry.args ? { args: entry.args } : {}),
      ...(entry.env ? { env: entry.env } : {}),
      ...(transport === "stdio" && stdio?.cwd ? { cwd: stdio.cwd } : {}),
      ...(transport === "stdio" && stdio?.sandbox ? { sandbox: stdio.sandbox } : {}),
      ...(entry.url ? { url: entry.url } : {}),
      ...(entry.headers ? { headers: entry.headers } : {})
    };
  }
  return configs;
}

function emptyStatus(serverId: string, entry: McpServerEntry): McpServerStatus | undefined {
  const transport = normalizeMcpTransport(entry);
  if (!transport) {
    return undefined;
  }
  return {
    serverId,
    name: serverName(serverId, entry),
    transport,
    enabled: entry.enabled,
    status: "disconnected",
    tools: [],
    toolDetails: []
  };
}

function mapSdkStatus(serverId: string, entry: McpServerEntry, status?: McpClientServerStatus): McpServerStatus | undefined {
  const base = emptyStatus(serverId, entry);
  if (!base) {
    return undefined;
  }
  if (!entry.enabled || !status) {
    return base;
  }

  if (status.status === "connected") {
    return {
      ...base,
      status: "connected",
      tools: status.tools,
      toolDetails: status.toolDetails,
      lastConnectedAt: status.lastConnectedAt,
      lastCheckedAt: status.lastCheckedAt
    };
  }
  if (status.status === "connecting") {
    return {
      ...base,
      status: "connecting",
      lastCheckedAt: status.lastCheckedAt
    };
  }
  if (status.status === "failed") {
    const publicError = mapPublicError(
      status.error ? Object.assign(new Error(status.error.message), { code: status.error.code }) : new Error("MCP connection failed"),
      entry
    );
    return {
      ...base,
      status: publicError.code === "auth_needed" ? "auth_needed" : "error",
      error: publicError,
      lastCheckedAt: status.lastCheckedAt
    };
  }
  return base;
}

function mapResource(serverId: string, entry: McpServerEntry, resource: Record<string, unknown>): McpResourceSummary {
  return {
    serverId,
    serverName: serverName(serverId, entry),
    uri: typeof resource.uri === "string" ? resource.uri : "",
    ...(typeof resource.name === "string" ? { name: resource.name } : {}),
    ...(typeof resource.description === "string" ? { description: resource.description } : {}),
    ...(typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {})
  };
}

function isMcpToolEnabled(tool: { name: string; originalName: string; wrapperName: string }, entry?: McpServerEntry): boolean {
  const disabledTools = new Set(entry?.disabledTools ?? []);
  return !disabledTools.has(tool.originalName)
    && !disabledTools.has(tool.wrapperName)
    && !disabledTools.has(tool.name);
}

export class WorkspaceMcpManager {
  private readonly readConfig: (workspaceSlug: string) => WorkspaceMcpConfig;
  private readonly sdkManagerFactory: () => WorkspaceSdkMcpManager;
  private readonly logger: Pick<Logger, "warn" | "error" | "info">;
  private readonly authorizeConnect?: (serverId: string) => Promise<McpGateDecision>;
  private readonly stdioSandbox?: SandboxSettings;
  private readonly stdioCwd?: string;
  private readonly workspaces = new Map<string, WorkspaceState>();

  constructor(options: WorkspaceMcpManagerOptions = {}) {
    this.readConfig = options.readConfig ?? getWorkspaceMcpConfig;
    this.sdkManagerFactory = options.sdkManagerFactory ?? (() => new McpClientManager());
    this.logger = options.logger ?? singletonLogger;
    this.authorizeConnect = options.authorizeConnect;
    this.stdioSandbox = options.stdioSandbox;
    this.stdioCwd = options.stdioCwd;
  }

  async syncWorkspace(workspaceSlug: string, options: SyncWorkspaceOptions = {}): Promise<void> {
    const config = this.readConfig(workspaceSlug);
    const normalized = this.normalizedConfigs(config);
    const state = this.ensureWorkspaceState(workspaceSlug);
    const currentIds = new Set(Object.keys(normalized));
    const currentEnabledIds = new Set(Object.entries(normalized)
      .filter(([, entry]) => entry.enabled)
      .map(([serverId]) => serverId));

    for (const serverId of state.knownServerIds) {
      if (!currentIds.has(serverId) || !currentEnabledIds.has(serverId)) {
        await state.sdk.disconnect(serverId);
      }
    }

    state.sdk.sync(normalized);
    state.knownServerIds = currentIds;
    this.logger.info("MCP workspace synced", {
      workspaceSlug,
      totalServers: currentIds.size,
      enabledServers: currentEnabledIds.size
    });

    const connectionAttempts: Array<Promise<void>> = [];
    for (const serverId of currentEnabledIds) {
      if (this.authorizeConnect) {
        let gate: McpGateDecision;
        try {
          gate = await this.authorizeConnect(serverId);
        } catch (error) {
          gate = {
            decision: "block",
            reason: `authorizeConnect threw: ${error instanceof Error ? error.message : String(error)}`
          };
        }
        if (gate.decision === "block") {
          this.logger.warn("MCP server connection blocked by gate", {
            workspaceSlug,
            serverId,
            reason: gate.reason
          });
          continue;
        }
      }
      const connect = state.sdk.ensureConnected ?? state.sdk.connect;
      if (!connect) {
        continue;
      }
      const attempt = connect.call(state.sdk, serverId).catch((error: unknown) => {
        this.logger.warn("MCP server connection failed", {
          workspaceSlug,
          serverId,
          error: mapPublicError(error, config.servers[serverId]).message
        });
      });
      if (options.waitForConnections) {
        connectionAttempts.push(attempt);
      } else {
        void attempt;
      }
    }

    if (connectionAttempts.length > 0) {
      await Promise.all(connectionAttempts);
    }
  }

  getStatus(workspaceSlug: string): McpServerStatus[] {
    const config = this.readConfig(workspaceSlug);
    const sdkStatus = this.workspaces.get(workspaceSlug)?.sdk.getStatus() ?? {};
    return Object.entries(config.servers ?? {}).flatMap(([serverId, entry]) => {
      const status = mapSdkStatus(serverId, entry, sdkStatus[serverId]);
      return status ? [status] : [];
    });
  }

  async testServer(workspaceSlug: string, serverId: string): Promise<McpServerStatus> {
    const config = this.readConfig(workspaceSlug);
    const entry = config.servers[serverId];
    if (!entry) {
      throw new PublicMcpError("not_found", `MCP server not found: ${serverId}`);
    }
    const state = this.ensureWorkspaceState(workspaceSlug);
    state.sdk.sync(this.normalizedConfigs(config));
    try {
      await (state.sdk.connect ?? state.sdk.ensureConnected)?.call(state.sdk, serverId);
    } catch (error) {
      // 连接失败的底层错误常内嵌 URL/凭据片段；与其余 MCP 路径一致经脱敏再下发，
      // 且错误码归一，不把原文直抛 renderer（#403）
      const entry = config.servers[serverId];
      const publicError = mapPublicError(error, entry);
      throw new PublicMcpError(publicError.code, publicError.message);
    }
    const status = this.getStatus(workspaceSlug).find((item) => item.serverId === serverId);
    if (!status) {
      throw new PublicMcpError("not_found", `MCP server not found: ${serverId}`);
    }
    return status;
  }

  private normalizedConfigs(config: WorkspaceMcpConfig): Record<string, NormalizedMcpServerConfig> {
    return toNormalizedConfigs(config, {
      sandbox: this.stdioSandbox,
      cwd: this.stdioCwd
    });
  }

  async listResources(input: { workspaceSlug: string; serverId?: string }): Promise<ListMcpResourcesResponse> {
    await this.syncWorkspace(input.workspaceSlug);
    const config = this.readConfig(input.workspaceSlug);
    const state = this.ensureWorkspaceState(input.workspaceSlug);
    const serverIds = input.serverId
      ? [input.serverId]
      : Object.entries(config.servers ?? {}).filter(([, entry]) => entry.enabled).map(([serverId]) => serverId);
    const resources: McpResourceSummary[] = [];
    const errors: Array<{ serverId: string; code: string; message: string }> = [];

    for (const serverId of serverIds) {
      const entry = config.servers[serverId];
      if (!entry) {
        errors.push({ serverId, code: "not_found", message: `MCP server not found: ${serverId}` });
        continue;
      }
      try {
        const result = await state.sdk.listResources(serverId);
        resources.push(...(result.resources ?? []).map((resource) => mapResource(serverId, entry, resource)));
      } catch (error) {
        if (isUnsupportedResourceListError(error)) {
          continue;
        }
        errors.push({ serverId, ...mapPublicError(error, entry) });
      }
    }

    return {
      resources,
      ...(errors.length > 0 ? { errors } : {})
    };
  }

  async readResource(input: { workspaceSlug: string; serverId: string; uri: string }): Promise<ReadMcpResourceResponse> {
    await this.syncWorkspace(input.workspaceSlug);
    const config = this.readConfig(input.workspaceSlug);
    const entry = config.servers[input.serverId];
    if (!entry) {
      throw new PublicMcpError("not_found", `MCP server not found: ${input.serverId}`);
    }
    try {
      const result = await this.ensureWorkspaceState(input.workspaceSlug).sdk.readResource(input.serverId, input.uri);
      return {
        serverId: input.serverId,
        uri: input.uri,
        contents: enforceMcpResourcePreviewLimit(result.contents)
      };
    } catch (error) {
      const publicError = mapPublicError(error, entry);
      throw new PublicMcpError(publicError.code, publicError.message);
    }
  }

  async callToolDiagnostic(input: CallMcpToolDiagnosticRequest): Promise<CallMcpToolDiagnosticResponse> {
    await this.syncWorkspace(input.workspaceSlug);
    const config = this.readConfig(input.workspaceSlug);
    const entry = config.servers[input.serverId];
    if (!entry) {
      return {
        serverId: input.serverId,
        originalToolName: input.originalToolName,
        error: { code: "not_found", message: `MCP server not found: ${input.serverId}` }
      };
    }
    const startedAt = Date.now();
    try {
      this.logger.info("MCP diagnostic tool call started", {
        workspaceSlug: input.workspaceSlug,
        serverId: input.serverId,
        originalToolName: input.originalToolName,
        argsSummary: createDiagnosticLogSummary(input.args)
      });
      const result = await this.ensureWorkspaceState(input.workspaceSlug).sdk.callTool(
        input.serverId,
        input.originalToolName,
        input.args,
        { timeoutMs: input.timeoutMs }
      );
      this.logger.info("MCP diagnostic tool call completed", {
        workspaceSlug: input.workspaceSlug,
        serverId: input.serverId,
        originalToolName: input.originalToolName,
        isError: result.isError === true,
        truncated: result.truncated === true,
        textSummary: createDiagnosticLogSummary(result.text),
        elapsedMs: Date.now() - startedAt
      });
      return {
        serverId: input.serverId,
        originalToolName: input.originalToolName,
        text: result.text,
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
        ...(result.isError !== undefined ? { isError: result.isError } : {}),
        ...(result.truncated !== undefined ? { truncated: result.truncated } : {})
      };
    } catch (error) {
      const publicError = mapPublicError(error, entry);
      this.logger.warn("MCP diagnostic tool call failed", {
        workspaceSlug: input.workspaceSlug,
        serverId: input.serverId,
        originalToolName: input.originalToolName,
        error: publicError.message,
        elapsedMs: Date.now() - startedAt
      });
      return {
        serverId: input.serverId,
        originalToolName: input.originalToolName,
        error: publicError
      };
    }
  }

  async createRuntimeTools(
    workspaceSlug: string,
    options: CreateRuntimeToolsOptions = {},
  ): Promise<WorkspaceMcpRuntimeTools> {
    await this.syncWorkspace(workspaceSlug, { waitForConnections: true });
    const config = this.readConfig(workspaceSlug);
    const statuses = this.getStatus(workspaceSlug);
    const connectedTools = statuses
      .filter((status) => status.enabled && status.status === "connected")
      .flatMap((status) => status.toolDetails
        .filter((tool) => isMcpToolEnabled(tool, config.servers[status.serverId])));
    const diagnostics: ToolRuntimeDiagnostic[] = statuses
      .filter((status) => status.enabled && status.status !== "connected" && status.error)
      .map((status) => ({
        pluginName: `MCP: ${status.serverId}`,
        severity: "warning",
        reason: status.error?.message ?? `MCP server ${status.serverId} is not connected.`
      }));

    const includeManagement = options.includeManagementTools ?? true;

    return {
      tools: [
        ...createWorkspaceMcpToolDefinitions({
          workspaceSlug,
          tools: connectedTools,
          callTool: (targetWorkspaceSlug, serverId, originalToolName, args, opts) =>
            this.callRuntimeTool(targetWorkspaceSlug, serverId, originalToolName, args, opts),
          isToolEnabled: (targetWorkspaceSlug, tool) =>
            isMcpToolEnabled(tool, this.readConfig(targetWorkspaceSlug).servers[tool.serverId]),
          ...(options.toolMetadataProvider
            ? { runtimeMetadata: (tool) => options.toolMetadataProvider!(tool.serverId) }
            : {})
        }),
        ...(includeManagement
          ? [
              createWorkspaceMcpConfigTool({
                workspaceSlug,
                getStatus: (targetWorkspaceSlug) => this.getStatus(targetWorkspaceSlug)
              }),
              ...createWorkspaceMcpResourceTools({
                workspaceSlug,
                listResources: (targetWorkspaceSlug, serverId) =>
                  this.listResources({ workspaceSlug: targetWorkspaceSlug, serverId }),
                readResource: (targetWorkspaceSlug, serverId, uri) =>
                  this.readResource({ workspaceSlug: targetWorkspaceSlug, serverId, uri })
              })
            ]
          : [])
      ],
      diagnostics
    };
  }

  async disposeWorkspace(workspaceSlug: string): Promise<void> {
    const state = this.workspaces.get(workspaceSlug);
    if (!state) {
      return;
    }
    await state.sdk.dispose();
    this.workspaces.delete(workspaceSlug);
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.workspaces.keys()].map((workspaceSlug) => this.disposeWorkspace(workspaceSlug)));
  }

  private async callRuntimeTool(
    workspaceSlug: string,
    serverId: string,
    originalToolName: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ): Promise<McpCallResult> {
    await this.syncWorkspace(workspaceSlug);
    const state = this.ensureWorkspaceState(workspaceSlug);
    const startedAt = Date.now();
    this.logger.info("MCP runtime tool call started", {
      workspaceSlug,
      serverId,
      originalToolName,
      argsSummary: createDiagnosticLogSummary(args)
    });
    try {
      const result = await state.sdk.callTool(serverId, originalToolName, args, options);
      this.logger.info("MCP runtime tool call completed", {
        workspaceSlug,
        serverId,
        originalToolName,
        isError: result.isError === true,
        truncated: result.truncated === true,
        textSummary: createDiagnosticLogSummary(result.text),
        elapsedMs: Date.now() - startedAt
      });
      return result;
    } catch (error) {
      this.logger.warn("MCP runtime tool call failed", {
        workspaceSlug,
        serverId,
        originalToolName,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt
      });
      throw error;
    }
  }

  private ensureWorkspaceState(workspaceSlug: string): WorkspaceState {
    const existing = this.workspaces.get(workspaceSlug);
    if (existing) {
      return existing;
    }
    const next: WorkspaceState = {
      sdk: this.sdkManagerFactory(),
      knownServerIds: new Set()
    };
    this.workspaces.set(workspaceSlug, next);
    return next;
  }
}

const MCP_RESOURCE_PREVIEW_LIMIT_BYTES = 10 * 1024 * 1024;

function enforceMcpResourcePreviewLimit(contents: unknown[]): unknown[] {
  for (const content of contents) {
    const record = content && typeof content === "object" ? content as Record<string, unknown> : null;
    if (typeof record?.text === "string"
      && Buffer.byteLength(record.text, "utf8") > MCP_RESOURCE_PREVIEW_LIMIT_BYTES) {
      throw new PublicMcpError("resource_too_large", "MCP 资源文本超过 10 MB 预览上限");
    }
    if (typeof record?.blob === "string"
      && record.blob.length > Math.ceil(MCP_RESOURCE_PREVIEW_LIMIT_BYTES * 4 / 3) + 4) {
      throw new PublicMcpError("resource_too_large", "MCP 资源二进制内容超过 10 MB 预览上限");
    }
    if (!record || (typeof record.text !== "string" && typeof record.blob !== "string")) {
      const serialized = JSON.stringify(content);
      if (serialized && Buffer.byteLength(serialized, "utf8") > MCP_RESOURCE_PREVIEW_LIMIT_BYTES) {
        throw new PublicMcpError("resource_too_large", "MCP 资源内容超过 10 MB 预览上限");
      }
    }
  }
  return contents;
}

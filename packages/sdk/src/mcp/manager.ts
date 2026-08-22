import type { SandboxSettings } from '../types.js';
import { SandboxedStdioClientTransport } from './sandboxed-stdio-transport.js';

export type McpTransportKind = 'stdio' | 'sse' | 'streamable_http';
export type McpClientStatus = 'idle' | 'connecting' | 'connected' | 'failed';
export type McpClientErrorCode =
  | 'invalid_config'
  | 'transport_error'
  | 'protocol_error'
  | 'timeout'
  | 'auth_error'
  | 'aborted';

export interface NormalizedMcpServerConfig {
  name?: string;
  enabled: boolean;
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  sandbox?: SandboxSettings;
  url?: string;
  headers?: Record<string, string>;
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

export interface McpClientServerStatus {
  serverId: string;
  name: string;
  transport: McpTransportKind;
  enabled: boolean;
  status: McpClientStatus;
  tools: string[];
  toolDetails: McpToolDetail[];
  error?: { code: McpClientErrorCode; message: string };
  lastConnectedAt?: number;
  lastCheckedAt?: number;
}

export interface McpCallResult {
  text: string;
  structuredContent?: unknown;
  isError?: boolean;
  truncated?: boolean;
}

export interface McpListResourcesResult {
  resources: Array<Record<string, unknown>>;
}

export interface McpReadResourceResult {
  contents: unknown[];
}

export interface McpClientLike {
  connect(transport: unknown): Promise<void>;
  listTools?(): Promise<{ tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }>;
  callTool?(input: { name: string; arguments: Record<string, unknown> }, options?: { signal?: AbortSignal; timeout?: number }): Promise<unknown>;
  listResources?(params?: unknown, options?: { signal?: AbortSignal; timeout?: number }): Promise<{ resources?: Array<Record<string, unknown>> }>;
  readResource?(input: { uri: string }, options?: { signal?: AbortSignal; timeout?: number }): Promise<{ contents?: unknown[] }>;
  close?(): Promise<void>;
  /**
   * 连接意外关闭回调字段（stdio server 崩溃/远端断开）；用于把状态打回 failed 自愈（#403）。
   * SDK Protocol.onclose 是零参回调字段（_onclose() 直接调用），不是注册方法——manager
   * 连接成功后直接赋值（#455）。
   */
  onclose?: () => void;
}

export type McpClientFactory = (
  serverId: string,
  config: NormalizedMcpServerConfig
) => McpClientLike | Promise<McpClientLike>;

export type McpTransportFactory = (
  serverId: string,
  config: NormalizedMcpServerConfig
) => unknown | Promise<unknown>;

export interface McpClientManagerOptions {
  clientFactory?: McpClientFactory;
  transportFactory?: McpTransportFactory;
  defaultConnectTimeoutMs?: number;
  defaultCallTimeoutMs?: number;
  /** #312:failed 负缓存退避基数(默认 5s,指数 ×2) */
  failureRetryBaseMs?: number;
  /** #312:failed 负缓存退避封顶(默认 60s) */
  failureRetryMaxMs?: number;
}

interface ServerState {
  config: NormalizedMcpServerConfig;
  status: McpClientStatus;
  tools: McpToolDetail[];
  generation: number;
  error?: { code: McpClientErrorCode; message: string };
  client?: McpClientLike;
  connectingPromise?: Promise<void>;
  lastConnectedAt?: number;
  lastCheckedAt?: number;
  /** #312:连续失败次数(成功清零),驱动指数退避 */
  failureCount?: number;
  /** #312:负缓存水位,此前不发起连接直接抛缓存错误 */
  nextRetryAt?: number;
}

class McpManagerError extends Error {
  code: McpClientErrorCode;

  constructor(code: McpClientErrorCode, message: string) {
    super(message);
    this.name = 'McpManagerError';
    this.code = code;
  }
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
// #312:failed 负缓存退避——协议挂死/npx 冷启动超时的服务器每 run 全量重连会让
// waitForConnections 卡满 connect timeout(多服务器放大为 N×30s)。指数退避封顶 60s。
const FAILURE_RETRY_BASE_MS = 5_000;
const FAILURE_RETRY_MAX_MS = 60_000;
const MAX_TEXT_CHARS = 200_000;
const TRUNCATED_SUFFIX = '\n[truncated]';

function createMcpError(code: McpClientErrorCode, message: string): McpManagerError {
  return new McpManagerError(code, message);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function classifyError(error: unknown, fallback: McpClientErrorCode = 'protocol_error'): McpManagerError {
  if (error instanceof McpManagerError) {
    return error;
  }

  const message = getErrorMessage(error);
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === 'ABORT_ERR') {
    return createMcpError('aborted', message || 'MCP operation aborted');
  }
  // Bare 'auth'/'token' matched unrelated messages like "exceeded token limit"
  // and steered users toward API-key fixes; keep the word list explicit (#226).
  if (/\b401\b|\b403\b|unauthorized|forbidden|api[ _-]?key/i.test(message)) {
    return createMcpError('auth_error', message);
  }
  if (/timed out|timeout/i.test(message)) {
    return createMcpError('timeout', message);
  }
  if (isConnectionError(error)) {
    return createMcpError('transport_error', message);
  }
  return createMcpError(fallback, message);
}

function isConnectionError(error: unknown): boolean {
  if (error instanceof McpManagerError) {
    return error.code === 'transport_error';
  }
  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && /ECONN|EPIPE|ENOTFOUND|ETIMEDOUT/i.test(code)) {
    return true;
  }
  return /connection|closed|disconnect|socket hang up|reset|econn|epipe/i.test(getErrorMessage(error));
}

function validateConfig(config: NormalizedMcpServerConfig): McpManagerError | undefined {
  if (!config.enabled) {
    return createMcpError('invalid_config', 'MCP server is disabled');
  }
  if (config.transport === 'stdio' && !config.command?.trim()) {
    return createMcpError('invalid_config', 'stdio MCP server requires command');
  }
  if ((config.transport === 'sse' || config.transport === 'streamable_http') && !config.url?.trim()) {
    return createMcpError('invalid_config', 'remote MCP server requires url');
  }
  return undefined;
}

function stringArraysEqual(left?: string[], right?: string[]): boolean {
  if (!left || !right) {
    return !left && !right;
  }
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stringRecordsEqual(left?: Record<string, string>, right?: Record<string, string>): boolean {
  if (!left || !right) {
    return !left && !right;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return stringArraysEqual(leftKeys, rightKeys) && leftKeys.every((key) => left[key] === right[key]);
}

function configsEqual(left: NormalizedMcpServerConfig, right: NormalizedMcpServerConfig): boolean {
  return left.name === right.name
    && left.enabled === right.enabled
    && left.transport === right.transport
    && left.command === right.command
    && left.cwd === right.cwd
    && left.url === right.url
    && stringArraysEqual(left.args, right.args)
    && stringRecordsEqual(left.env, right.env)
    && stringRecordsEqual(left.headers, right.headers)
    && JSON.stringify(left.sandbox) === JSON.stringify(right.sandbox);
}

function cloneConfig(config: NormalizedMcpServerConfig): NormalizedMcpServerConfig {
  return {
    ...config,
    ...(config.args ? { args: [...config.args] } : {}),
    ...(config.env ? { env: { ...config.env } } : {}),
    ...(config.headers ? { headers: { ...config.headers } } : {}),
    ...(config.sandbox ? { sandbox: structuredClone(config.sandbox) } : {})
  };
}

function normalizeServerId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'server';
}

function normalizeToolName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'tool';
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(6, '0').slice(0, 6);
}

function buildWrapperName(serverId: string, originalToolName: string, takenNames: Set<string>): string {
  const serverNamespace = normalizeServerId(serverId);
  const toolNamespace = normalizeToolName(originalToolName);
  const base = `mcp__${serverNamespace}__${toolNamespace}`;
  if (!takenNames.has(base)) {
    takenNames.add(base);
    return base;
  }

  const suffix = shortHash(`${serverNamespace}\0${originalToolName}`);
  let candidate = `${base}_${suffix}`;
  let counter = 2;
  while (takenNames.has(candidate)) {
    candidate = `${base}_${suffix}_${counter}`;
    counter += 1;
  }
  takenNames.add(candidate);
  return candidate;
}

function buildToolDetails(
  serverId: string,
  config: NormalizedMcpServerConfig,
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>
): McpToolDetail[] {
  const takenNames = new Set<string>();
  return tools.map((tool) => {
    const wrapperName = buildWrapperName(serverId, tool.name, takenNames);
    return {
      name: wrapperName,
      originalName: tool.name,
      wrapperName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      serverId,
      serverName: config.name ?? serverId
    };
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) {
    throw createMcpError('aborted', 'MCP operation aborted');
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = () => {
      settle(() => reject(createMcpError('aborted', 'MCP operation aborted')));
    };

    timer = setTimeout(() => {
      settle(() => reject(createMcpError('timeout', `MCP operation timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref?.(); // 不让挂起中的预算计时器拖住进程退出（#455 P3）
    signal?.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error))
    );
  });
}

/**
 * Like withTimeout, but the timed-out operation is an MCP request: aborting
 * the signal makes the official SDK client emit notifications/cancelled and
 * drop the entry from its pending map, while the race still protects callers
 * whose client ignores the signal. Without this, slow servers accumulated
 * permanently-pending requests on every timeout (#226).
 */
async function withRequestTimeout<T>(
  makeRequest: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) {
    throw createMcpError('aborted', 'MCP operation aborted');
  }

  const controller = new AbortController();
  const request = makeRequest(controller.signal);
  request.catch(() => undefined); // losing the race must not surface as an unhandled rejection

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = () => {
      controller.abort();
      settle(() => reject(createMcpError('aborted', 'MCP operation aborted')));
    };

    timer = setTimeout(() => {
      controller.abort();
      settle(() => reject(createMcpError('timeout', `MCP operation timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref?.(); // 不让挂起中的预算计时器拖住进程退出（#455 P3）
    signal?.addEventListener('abort', onAbort, { once: true });

    request.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error))
    );
  });
}

function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEXT_CHARS) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, MAX_TEXT_CHARS)}${TRUNCATED_SUFFIX}`,
    truncated: true
  };
}

function normalizeCallResult(result: unknown): McpCallResult {
  const resultObject = typeof result === 'object' && result !== null
    ? result as Record<string, unknown>
    : undefined;
  const content = Array.isArray(resultObject?.content) ? resultObject.content : undefined;
  const chunks: string[] = [];

  if (content) {
    for (const block of content) {
      if (
        typeof block === 'object'
        && block !== null
        && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string'
      ) {
        chunks.push((block as { text: string }).text);
      } else {
        chunks.push(JSON.stringify(block));
      }
    }
  } else if (resultObject?.structuredContent !== undefined) {
    chunks.push('');
  } else {
    chunks.push(typeof result === 'string' ? result : JSON.stringify(result));
  }

  const truncated = truncateText(chunks.join(''));
  return {
    text: truncated.text,
    ...(resultObject?.structuredContent !== undefined ? { structuredContent: resultObject.structuredContent } : {}),
    ...(resultObject?.isError !== undefined ? { isError: Boolean(resultObject.isError) } : {}),
    ...(truncated.truncated ? { truncated: true } : {})
  };
}

async function defaultClientFactory(serverId: string): Promise<McpClientLike> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  return new Client(
    { name: `lume-agent-sdk-${serverId}`, version: '1.0.0' },
    {}
  ) as McpClientLike;
}

async function defaultTransportFactory(
  _serverId: string,
  config: NormalizedMcpServerConfig
): Promise<unknown> {
  if (config.transport === 'stdio') {
    // Never hand the host's full environment (API keys, tokens) to third-party
    // server processes; the official SDK default is a minimal safe subset (#201).
    const { StdioClientTransport, getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    if (config.sandbox?.processIsolation?.enabled) {
      return new SandboxedStdioClientTransport({
        command: config.command ?? '',
        args: config.args ?? [],
        env: { ...getDefaultEnvironment(), ...config.env } as Record<string, string>,
        cwd: config.cwd,
        sandbox: config.sandbox,
      });
    }
    return new StdioClientTransport({
      command: config.command ?? '',
      args: config.args ?? [],
      cwd: config.cwd,
      env: { ...getDefaultEnvironment(), ...config.env } as Record<string, string>
    });
  }

  if (config.transport === 'sse') {
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    return new SSEClientTransport(new URL(config.url ?? ''), {
      requestInit: config.headers ? { headers: config.headers } : undefined
    } as any);
  }

  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  return new StreamableHTTPClientTransport(new URL(config.url ?? ''), {
    requestInit: config.headers ? { headers: config.headers } : undefined
  } as any);
}

export class McpClientManager {
  private readonly clientFactory: McpClientFactory;
  private readonly transportFactory: McpTransportFactory;
  private readonly defaultConnectTimeoutMs: number;
  private readonly defaultCallTimeoutMs: number;
  private readonly failureRetryBaseMs: number;
  private readonly failureRetryMaxMs: number;
  private readonly servers = new Map<string, ServerState>();

  constructor(options: McpClientManagerOptions = {}) {
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.transportFactory = options.transportFactory ?? defaultTransportFactory;
    this.defaultConnectTimeoutMs = options.defaultConnectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.defaultCallTimeoutMs = options.defaultCallTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.failureRetryBaseMs = options.failureRetryBaseMs ?? FAILURE_RETRY_BASE_MS;
    this.failureRetryMaxMs = options.failureRetryMaxMs ?? FAILURE_RETRY_MAX_MS;
  }

  register(serverId: string, config: NormalizedMcpServerConfig): void {
    const existing = this.servers.get(serverId);
    if (existing && configsEqual(existing.config, config)) {
      return;
    }
    if (existing?.client) {
      void this.closeState(existing);
    }
    this.servers.set(serverId, {
      config: cloneConfig(config),
      status: 'idle',
      tools: [],
      generation: 0
    });
  }

  sync(configs: Record<string, NormalizedMcpServerConfig>): void {
    const nextIds = new Set(Object.keys(configs));
    for (const serverId of this.servers.keys()) {
      if (!nextIds.has(serverId)) {
        void this.disconnect(serverId);
        this.servers.delete(serverId);
      }
    }
    for (const [serverId, config] of Object.entries(configs)) {
      this.register(serverId, config);
    }
  }

  async connect(serverId: string): Promise<void> {
    await this.ensureConnected(serverId);
  }

  async ensureConnected(serverId: string): Promise<void> {
    const state = this.getStateOrThrow(serverId);
    if (state.status === 'connected' && state.client) {
      return;
    }
    // #312:failed 负缓存——退避窗口内不发起连接,快速抛缓存错误
    //(waitForConnections 的调用方 catch 吞掉,run 启动不再被挂死服务器卡满 timeout)
    if (
      state.status === 'failed'
      && state.nextRetryAt !== undefined
      && Date.now() < state.nextRetryAt
    ) {
      throw createMcpError(
        state.error?.code ?? 'transport_error',
        state.error?.message ?? `MCP server "${serverId}" recently failed; backing off before retry`,
      );
    }
    if (state.connectingPromise) {
      return state.connectingPromise;
    }

    const connectingPromise = this.openConnection(serverId, state);
    state.connectingPromise = connectingPromise;
    try {
      await connectingPromise;
    } finally {
      if (state.connectingPromise === connectingPromise) {
        state.connectingPromise = undefined;
      }
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const state = this.servers.get(serverId);
    if (!state) {
      return;
    }
    state.generation += 1;
    await this.closeState(state);
    state.status = 'idle';
    state.tools = [];
    state.error = undefined;
    // 显式断开/重配后允许立即重试(#312:清负缓存)
    state.failureCount = 0;
    state.nextRetryAt = undefined;
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.servers.keys()].map((serverId) => this.disconnect(serverId)));
    this.servers.clear();
  }

  getStatus(): Record<string, McpClientServerStatus> {
    const status: Record<string, McpClientServerStatus> = {};
    for (const [serverId, state] of this.servers.entries()) {
      status[serverId] = {
        serverId,
        name: state.config.name ?? serverId,
        transport: state.config.transport,
        enabled: state.config.enabled,
        status: state.status,
        tools: state.tools.map((tool) => tool.originalName),
        // Copy the entries: handing out the live array lets callers sort/splice
        // the manager's internal tool list (#226).
        toolDetails: state.tools.map((tool) => ({ ...tool })),
        ...(state.error ? { error: state.error } : {}),
        ...(state.lastConnectedAt ? { lastConnectedAt: state.lastConnectedAt } : {}),
        ...(state.lastCheckedAt ? { lastCheckedAt: state.lastCheckedAt } : {})
      };
    }
    return status;
  }

  getTools(serverId?: string): McpToolDetail[] {
    if (serverId) {
      return [...(this.servers.get(serverId)?.tools ?? [])];
    }
    return [...this.servers.values()].flatMap((state) => state.tools);
  }

  async callTool(
    serverId: string,
    originalToolName: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<McpCallResult> {
    return this.callToolWithRetry(serverId, originalToolName, args, options, false);
  }

  async listResources(serverId?: string): Promise<McpListResourcesResult> {
    if (serverId) {
      const state = await this.getConnectedState(serverId);
      const result = await withRequestTimeout(
        (requestSignal) => Promise.resolve(state.client?.listResources?.(undefined, { signal: requestSignal, timeout: this.defaultCallTimeoutMs }) ?? { resources: [] }),
        this.defaultCallTimeoutMs
      );
      return { resources: result.resources ?? [] };
    }

    const resources: Array<Record<string, unknown>> = [];
    for (const [id, state] of this.servers.entries()) {
      if (!state.config.enabled) {
        continue;
      }
      resources.push(...(await this.listResources(id)).resources);
    }
    return { resources };
  }

  async readResource(serverId: string, uri: string): Promise<McpReadResourceResult> {
    const state = await this.getConnectedState(serverId);
    const result = await withRequestTimeout(
      (requestSignal) => Promise.resolve(state.client?.readResource?.({ uri }, { signal: requestSignal, timeout: this.defaultCallTimeoutMs }) ?? { contents: [] }),
      this.defaultCallTimeoutMs
    );
    return { contents: result.contents ?? [] };
  }

  private async callToolWithRetry(
    serverId: string,
    originalToolName: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number },
    didRetry: boolean
  ): Promise<McpCallResult> {
    const state = await this.getConnectedState(serverId);
    // SDK Protocol.request 无条件套 options?.timeout ?? 60_000：预算必须透传进
    // options，否则 >60s 的配置预算永远被 SDK 内建 60s 先爆（#455 P2）。
    const budgetMs = options.timeoutMs ?? this.defaultCallTimeoutMs;
    try {
      const result = await withRequestTimeout(
        (requestSignal) => Promise.resolve(
          state.client?.callTool?.({ name: originalToolName, arguments: args }, { signal: requestSignal, timeout: budgetMs })
        ),
        budgetMs,
        options.signal
      );
      return normalizeCallResult(result);
    } catch (error) {
      const classified = classifyError(error);
      if (!didRetry && classified.code !== 'timeout' && classified.code !== 'aborted' && isConnectionError(error)) {
        await this.disconnect(serverId);
        return this.callToolWithRetry(serverId, originalToolName, args, options, true);
      }
      throw classified;
    }
  }

  private async getConnectedState(serverId: string): Promise<ServerState> {
    await this.ensureConnected(serverId);
    const state = this.getStateOrThrow(serverId);
    if (!state.client) {
      throw createMcpError('protocol_error', `MCP server is not connected: ${serverId}`);
    }
    return state;
  }

  private getStateOrThrow(serverId: string): ServerState {
    const state = this.servers.get(serverId);
    if (!state) {
      throw createMcpError('invalid_config', `Unknown MCP server: ${serverId}`);
    }
    return state;
  }

  private async openConnection(serverId: string, state: ServerState): Promise<void> {
    const generation = state.generation;
    const isCurrent = () => this.servers.get(serverId) === state && state.generation === generation;
    state.status = 'connecting';
    state.error = undefined;
    state.lastCheckedAt = Date.now();

    const invalid = validateConfig(state.config);
    if (invalid) {
      state.status = 'failed';
      state.error = { code: invalid.code, message: invalid.message };
      throw invalid;
    }

    let client: McpClientLike | undefined;
    try {
      client = await this.clientFactory(serverId, state.config);
      if (!isCurrent()) throw createMcpError('aborted', `MCP connection was superseded: ${serverId}`);
      const transport = await this.transportFactory(serverId, state.config);
      if (!isCurrent()) throw createMcpError('aborted', `MCP connection was superseded: ${serverId}`);
      await withTimeout(Promise.resolve(client.connect(transport)), this.defaultConnectTimeoutMs);
      if (!isCurrent()) throw createMcpError('aborted', `MCP connection was superseded: ${serverId}`);
      state.client = client;
      const toolList = await withTimeout(
        Promise.resolve(client.listTools?.() ?? { tools: [] }),
        this.defaultConnectTimeoutMs
      );
      if (!isCurrent()) throw createMcpError('aborted', `MCP connection was superseded: ${serverId}`);

      state.tools = buildToolDetails(serverId, state.config, toolList.tools ?? []);
      state.status = 'connected';
      state.error = undefined;
      state.failureCount = 0;
      state.nextRetryAt = undefined;
      state.lastConnectedAt = Date.now();
      state.lastCheckedAt = Date.now();

      // 死连接自愈：server 进程崩溃后 status 原样停留 connected，ensureConnected
      // 短路、资源读持续报错且工具清单陈旧。onclose 把状态打回 failed，让下一次
      // ensureConnected 走正常重连（#403）。
      // SDK Protocol.onclose 是回调字段（onclose?: () => void，_onclose() 零参调用）
      // 而非注册方法；此前 client.onclose?.(listener) 对裸 SDK client 恒为 no-op，
      // 监听从未武装（#455）。必须直接赋值。
      client.onclose = () => {
        if (state.client !== client || !isCurrent()) return;
        void this.closeState(state).then(() => {
          if (!isCurrent()) return;
          state.status = 'failed';
          state.error = { code: 'transport_error', message: `MCP server "${serverId}" connection closed unexpectedly` };
          state.lastCheckedAt = Date.now();
        });
      };
    } catch (error) {
      if (state.client === client) {
        await this.closeState(state);
      } else {
        await this.closeClient(client);
      }
      const classified = classifyError(error, 'transport_error');
      if (isCurrent()) {
        state.status = 'failed';
        state.error = { code: classified.code, message: classified.message };
        state.lastCheckedAt = Date.now();
        // #312:失败计数+指数退避水位(基数 ×2 封顶)
        const failures = (state.failureCount ?? 0) + 1;
        state.failureCount = failures;
        state.nextRetryAt = Date.now() + Math.min(
          this.failureRetryMaxMs,
          this.failureRetryBaseMs * 2 ** (failures - 1),
        );
      }
      throw classified;
    }
  }

  private async closeState(state: ServerState): Promise<void> {
    const client = state.client;
    state.client = undefined;
    state.connectingPromise = undefined;
    await this.closeClient(client);
  }

  private async closeClient(client: McpClientLike | undefined): Promise<void> {
    if (!client?.close) return;
    try {
      await client.close();
    } catch {
      // ignore close errors
    }
  }
}

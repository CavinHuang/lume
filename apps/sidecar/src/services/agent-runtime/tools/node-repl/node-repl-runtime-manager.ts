import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { delimiter, dirname, join } from "node:path";
import { spawnWithProcessSandbox, type SandboxSettings } from "@lume/agent-sdk";
import { writeLogRecord, type LogLevel } from "../../../infra/logger";
import type {
  JsExecInput,
  NodeReplBrowserAuthRequest,
  NodeReplComputerUseResult,
  NodeReplContentBlock,
  NodeReplExecutionResult,
  NodeReplRuntimeClient,
  NodeReplRuntimeExecOptions,
  RuntimeFactoryInput
} from "./node-repl-types";
import {
  mergeComputerUseExecutionResult,
  parseComputerUseHostCall,
} from "./node-repl-computer-use-bridge";

const DEFAULT_CALL_TIMEOUT_MS = 35_000;
const DEFAULT_HOST_CALL_LEASE_MS = 10 * 60_000;
const MAX_STDERR_CHARS = 16_000;
// node_repl 宿主输出的单行结构化日志协议前缀（与 Rust logging.rs 保持一致）。
const LUMELOG_PREFIX = "LUMELOG ";

interface RuntimeControlResponse {
  type: "runtime_response";
  request_id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface RuntimeHostCall {
  type: "runtime_host_call";
  id: string;
  exec_id: string;
  method: string;
  args?: unknown;
}

interface RuntimeExecutionImage {
  dataBase64?: string;
  mimeType?: string;
  filePath?: string;
}

interface RuntimeExecutionValue {
  ok?: boolean;
  output?: string;
  error?: string;
  responseMeta?: Record<string, unknown>;
  images?: RuntimeExecutionImage[];
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ActiveExec {
  options?: NodeReplRuntimeExecOptions;
  abortController: AbortController;
  computerUseResults: NodeReplComputerUseResult[];
  execRequestId: string;
}

interface JsonlNodeReplRuntimeClientOptions {
  threadId: string;
  cwd: string;
  hostPath: string;
  kernelPath: string;
  nodePath: string;
  sandbox?: SandboxSettings;
  hostCallLeaseMs?: number;
}

export function createNodeReplRuntimeClientFromEnv(input: RuntimeFactoryInput): NodeReplRuntimeClient {
  const rootPath = requiredEnv("LUME_NODE_REPL_ROOT");
  return new JsonlNodeReplRuntimeClient({
    threadId: input.threadId,
    cwd: input.cwd,
    hostPath: requiredEnv("LUME_NODE_REPL_HOST"),
    kernelPath: join(rootPath, "runtime", "kernel-process.js"),
    nodePath: process.env.LUME_NODE_REPL_ELECTRON?.trim() || process.execPath,
    sandbox: input.sandbox
  });
}

export class JsonlNodeReplRuntimeClient implements NodeReplRuntimeClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<string, PendingCall>();
  private activeExecs = new Map<string, ActiveExec>();
  private stderr = "";
  private stderrLineBuffer = "";

  // 每次 spawn 新一代宿主时调用：旧代残留的半行 LUMELOG 若拼进新一代输出，
  // 最坏会被解析成新进程的结构化日志（错源归属），并污染退出诊断消息。
  private resetStderrBuffers(): void {
    this.stderr = "";
    this.stderrLineBuffer = "";
  }

  // LUMELOG 行转结构化日志；其余行维持旧行为：进 this.stderr，失败诊断时可见。
  private ingestStderrChunk(chunk: string): void {
    this.stderrLineBuffer += chunk;
    const lines = this.stderrLineBuffer.split("\n");
    this.stderrLineBuffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line) continue;
      if (!line.startsWith(LUMELOG_PREFIX)) {
        this.stderr = truncate(`${this.stderr}${line}\n`, MAX_STDERR_CHARS);
        continue;
      }
      try {
        // JSON.parse("null") 返回 null——非对象结果必须回退诊断缓冲，避免在 stderr
        // data handler 里抛未捕获异常击穿 sidecar。
        const parsed: unknown = JSON.parse(line.slice(LUMELOG_PREFIX.length));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        const host = parsed as {
          level?: string;
          context?: string;
          event?: string;
          message?: string;
          data?: Record<string, unknown>;
        };
        writeLogRecord({
          level: hostLogLevel(host.level),
          context: host.context ?? "node-repl.host",
          event: host.event ?? "host.log",
          message: host.message ?? "",
          ...(host.data ? { data: host.data } : {}),
        });
      } catch {
        this.stderr = truncate(`${this.stderr}${line}\n`, MAX_STDERR_CHARS);
      }
    }
  }

  constructor(private readonly options: JsonlNodeReplRuntimeClientOptions) {}

  async exec(input: JsExecInput, options?: NodeReplRuntimeExecOptions): Promise<NodeReplExecutionResult> {
    const execId = `node-repl-exec-${Date.now()}-${this.nextId++}`;
    const execRequestId = `node-repl-${this.nextId++}`;
    const abortController = new AbortController();
    const active: ActiveExec = { options, abortController, computerUseResults: [], execRequestId };
    this.activeExecs.set(execId, active);
    try {
      const value = await this.call("exec", {
        id: execId,
        code: input.code,
        ...(input.timeout_ms ? { timeout_ms: input.timeout_ms } : {}),
        ...(input._meta ? { request_meta: input._meta } : {})
      }, callTimeoutMs(input.timeout_ms), execRequestId);
      return mergeComputerUseExecutionResult(mapExecutionValue(value), active.computerUseResults);
    } finally {
      abortController.abort();
      this.activeExecs.delete(execId);
    }
  }

  async addNodeModuleDirectory(dir: string): Promise<boolean> {
    return Boolean(await this.call("add_node_module_dir", { path: dir }));
  }

  async reset(): Promise<void> {
    await this.call("reset", {});
  }

  async shutdown(): Promise<void> {
    if (!this.child) return;
    try {
      await this.call("shutdown", {}, 5_000);
    } catch {
      // The process may exit before the shutdown response is flushed.
    } finally {
      this.child?.kill();
      this.child = null;
      this.rejectAll(new Error("node_repl runtime shut down"));
    }
  }

  private async call(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_CALL_TIMEOUT_MS, requestIdOverride?: string): Promise<unknown> {
    this.ensureStarted();
    const child = this.child;
    const stdin = child?.stdin;
    if (!child || !stdin || !stdin.writable) {
      throw new Error("node_repl runtime stdin unavailable");
    }

    const requestId = requestIdOverride ?? `node-repl-${this.nextId++}`;
    const payload = JSON.stringify({
      request_id: requestId,
      method,
      params
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`node_repl ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
      stdin.write(`${payload}\n`, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  private ensureStarted(): void {
    if (this.child) return;

    const child = spawnWithProcessSandbox(this.options.hostPath, [
      "--runtime-jsonl",
      "--kernel-path",
      this.options.kernelPath,
      "--node-path",
      this.options.nodePath,
      "--working-dir",
      this.options.cwd
    ], {
      cwd: this.options.cwd,
      env: {
        ...buildNodeReplChildEnv(process.env),
        ELECTRON_RUN_AS_NODE: "1",
        NODE_REPL_HOST_PATH: this.options.hostPath,
        NODE_REPL_KERNEL_PATH: this.options.kernelPath,
        NODE_REPL_NODE_PATH: this.options.nodePath,
        NODE_REPL_SESSION_ID: this.options.threadId
      },
      stdio: ["pipe", "pipe", "pipe"]
    }, extendNodeReplSandbox(this.options));
    this.child = child;
    // 新一代进程必须从空缓冲开始：旧宿主崩溃残留的半行 LUMELOG 会与新宿主输出拼接，
    // 最坏拼成合法 JSON 被记成新进程的结构化日志（错源归属），并污染退出诊断消息。
    this.resetStderrBuffers();

    if (!child.stdin || !child.stdout || !child.stderr) {
      child.kill();
      this.child = null;
      throw new Error("node_repl sandbox did not provide stdio pipes");
    }
    createInterface({ input: child.stdout }).on("line", (line) => {
      this.handleLine(line);
    });
    child.stderr.on("data", (chunk) => {
      this.ingestStderrChunk(chunk.toString("utf8"));
    });
    child.once("error", (error) => {
      if (this.child === child) this.child = null;
      this.rejectAll(error);
    });
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      this.rejectAll(new Error(`node_repl runtime exited: code=${code ?? "null"} signal=${signal ?? "null"}${this.stderr ? `\n${this.stderr}` : ""}`));
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: RuntimeControlResponse | RuntimeHostCall;
    try {
      message = JSON.parse(trimmed) as RuntimeControlResponse | RuntimeHostCall;
    } catch {
      return;
    }
    if (message.type === "runtime_host_call") {
      void this.handleRuntimeHostCall(message);
      return;
    }
    if (message.type !== "runtime_response") return;

    const pending = this.pending.get(message.request_id);
    if (!pending) return;
    this.pending.delete(message.request_id);
    clearTimeout(pending.timeout);

    if (!message.ok) {
      pending.reject(new Error(message.error || "node_repl runtime call failed"));
      return;
    }
    pending.resolve(message.value);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async handleRuntimeHostCall(message: RuntimeHostCall): Promise<void> {
    const active = this.activeExecs.get(message.exec_id);
    if (active) this.extendExecDeadline(active);
    if (message.method === "computer.request") {
      if (!active?.options?.emitComputerUseRequest) {
        this.writeHostResult(message.id, false, undefined, "Computer Use bridge is unavailable");
        return;
      }
      try {
        const request = parseComputerUseHostCall(message.args);
        const result = await active.options.emitComputerUseRequest(request, active.abortController.signal);
        active.computerUseResults.push(result);
        this.writeHostResult(message.id, true, result.value);
      } catch (error) {
        this.writeHostResult(
          message.id,
          false,
          undefined,
          error instanceof Error ? error.message : "Computer Use request failed",
        );
      }
      return;
    }
    if (message.method === "tool_call" || message.method === "tool_list") {
      if (!active?.options?.toolRequest) {
        this.writeHostResult(message.id, false, undefined, "tools bridge is unavailable");
        return;
      }
      try {
        const value = await active.options.toolRequest(
          { method: message.method, args: isRecord(message.args) ? message.args : {} },
          active.abortController.signal
        );
        this.writeHostResult(message.id, true, value);
      } catch (error) {
        this.writeHostResult(message.id, false, undefined, error instanceof Error ? error.message : "tools bridge request failed");
      }
      return;
    }
    if (message.method === "browser.request") {
      if (!active?.options?.browserRequest) {
        this.writeHostResult(message.id, false, undefined, "Browser Broker is unavailable");
        return;
      }
      try {
        const args = isRecord(message.args) ? message.args : {};
        if (typeof args.method !== "string" || !isRecord(args.params)) throw new Error("invalid browser request");
        const value = await active.options.browserRequest({ method: args.method, params: args.params as Record<string, unknown> }, active.abortController.signal);
        this.writeHostResult(message.id, true, value);
      } catch (error) {
        this.writeHostResult(message.id, false, undefined, error instanceof Error ? error.message : "Browser Broker request failed");
      }
      return;
    }
    if (message.method !== "browserAuth.request" || !active?.options?.emitBrowserAuthRequest) {
      this.writeHostResult(message.id, true, { status: "unavailable" });
      return;
    }

    try {
      const result = await active.options.emitBrowserAuthRequest(
        isRecord(message.args) ? message.args as NodeReplBrowserAuthRequest : {},
        active.abortController.signal
      );
      this.writeHostResult(message.id, true, result);
    } catch {
      this.writeHostResult(message.id, true, { status: "unavailable" });
    }
  }

  // A host call (tool approval, browser request, ...) can wait on the user far
  // longer than the exec deadline; while it is in flight, re-arm the exec's
  // pending timeout to a one-shot lease so the sandbox thread is not torn down.
  private extendExecDeadline(active: ActiveExec): void {
    const pending = this.pending.get(active.execRequestId);
    if (!pending) return;
    const leaseMs = Math.max(this.options.hostCallLeaseMs ?? DEFAULT_HOST_CALL_LEASE_MS, 1);
    clearTimeout(pending.timeout);
    pending.timeout = setTimeout(() => {
      this.pending.delete(active.execRequestId);
      pending.reject(new Error(`node_repl exec timed out after ${leaseMs}ms`));
    }, leaseMs);
  }

  private writeHostResult(id: string, ok: boolean, value?: unknown, error?: string): void {
    const child = this.child;
    const stdin = child?.stdin;
    if (!child || !stdin || !stdin.writable) return;
    stdin.write(`${JSON.stringify({
      request_id: `host-result-${this.nextId++}`,
      method: "host_result",
      params: {
        id,
        ok,
        ...(value !== undefined ? { value } : {}),
        ...(error ? { error } : {})
      }
    })}\n`, "utf8");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extendNodeReplSandbox(options: JsonlNodeReplRuntimeClientOptions): SandboxSettings | undefined {
  if (!options.sandbox?.processIsolation?.enabled) return options.sandbox;
  return {
    ...options.sandbox,
    processIsolation: {
      ...options.sandbox.processIsolation,
      readonlyPaths: [
        ...(options.sandbox.processIsolation.readonlyPaths ?? []),
        dirname(options.hostPath),
        dirname(options.kernelPath),
        dirname(options.nodePath)
      ]
    }
  };
}

export function buildNodeReplChildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  const bundledRoot = base.LUME_BUNDLED_PLUGINS_DIR?.trim();
  const bundledClients = bundledRoot
    ? [
      { permission: "computerUse", path: join(bundledRoot, "computer-use", "scripts", "computer-use-client.mjs") },
      { permission: "browser", path: join(bundledRoot, "browser", "scripts", "browser-client.mjs") },
    ].filter((client) => existsSync(client.path))
    : [];

  const manifest = readRuntimeManifest(base.LUME_CUA_RUNTIME_MANIFEST);
  const bundledPermissions = new Set(bundledClients.map((client) => client.permission));
  const permissions = uniqueStrings([
    ...readStringArray(manifest.permissions).filter((permission) =>
      (permission !== "computerUse" && permission !== "browser") || bundledPermissions.has(permission)
    ),
    ...bundledPermissions,
  ]);
  if (permissions.length === 0 && !base.LUME_CUA_RUNTIME_MANIFEST) {
    delete env.LUME_CUA_RUNTIME_MANIFEST;
  } else {
    env.LUME_CUA_RUNTIME_MANIFEST = JSON.stringify({
      ...manifest,
      name: typeof manifest.name === "string" && manifest.name.trim()
        ? manifest.name
        : "lume-bundled-runtime",
      permissions,
    });
  }
  const trustedCodePaths = uniqueStrings([
    ...(base.NODE_REPL_TRUSTED_CODE_PATHS?.split(delimiter) ?? []),
    ...bundledClients.map((client) => client.path),
  ]);
  if (trustedCodePaths.length > 0) {
    env.NODE_REPL_TRUSTED_CODE_PATHS = trustedCodePaths.join(delimiter);
  } else {
    delete env.NODE_REPL_TRUSTED_CODE_PATHS;
  }
  return env;
}

function readRuntimeManifest(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function mapExecutionValue(value: unknown): NodeReplExecutionResult {
  const execution = isRecord(value) ? value as RuntimeExecutionValue : {};
  const content: NodeReplContentBlock[] = [];
  if (typeof execution.output === "string" && execution.output.length > 0) {
    content.push({ type: "text", text: execution.output });
  }
  if (execution.ok === false) {
    content.push({ type: "text", text: execution.error || "Execution failed" });
  }
  for (const image of execution.images ?? []) {
    if (typeof image.dataBase64 === "string" && typeof image.mimeType === "string") {
      content.push({ type: "image", data: image.dataBase64, mimeType: image.mimeType, _meta: { "codex/imageDetail": "original" } });
    } else if (typeof image.filePath === "string") {
      content.push({ type: "text", text: image.filePath });
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: execution.ok === false ? "Execution failed" : "" });
  }
  return {
    content,
    ...(execution.ok === false ? { isError: true } : {}),
    ...(isRecord(execution.responseMeta) ? { _meta: execution.responseMeta as Record<string, unknown> } : {})
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function callTimeoutMs(timeoutMs: number | undefined): number {
  if (!Number.isFinite(timeoutMs) || !timeoutMs || timeoutMs <= 0) {
    return DEFAULT_CALL_TIMEOUT_MS;
  }
  return Math.max(timeoutMs + 5_000, DEFAULT_CALL_TIMEOUT_MS);
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(-maxChars) : value;
}

// 宿主级别映射到 sidecar LogLevel：fatal 按 error 处理（Unit 5 协议约定），未知级别回落 info。
function hostLogLevel(value: string | undefined): LogLevel {
  if (value === "fatal") return "error";
  return value === "trace" || value === "debug" || value === "info" || value === "warn" || value === "error"
    ? value
    : "info";
}

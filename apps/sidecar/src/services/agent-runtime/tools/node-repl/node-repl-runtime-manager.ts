import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type {
  JsExecInput,
  NodeReplContentBlock,
  NodeReplExecutionResult,
  NodeReplRuntimeClient,
  RuntimeFactoryInput
} from "./node-repl-types";

const DEFAULT_CALL_TIMEOUT_MS = 35_000;
const MAX_STDERR_CHARS = 16_000;

interface RuntimeControlResponse {
  type: "runtime_response";
  request_id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
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

interface JsonlNodeReplRuntimeClientOptions {
  threadId: string;
  cwd: string;
  hostPath: string;
  kernelPath: string;
  nodePath: string;
}

export function createNodeReplRuntimeClientFromEnv(input: RuntimeFactoryInput): NodeReplRuntimeClient {
  const rootPath = requiredEnv("LUME_NODE_REPL_ROOT");
  return new JsonlNodeReplRuntimeClient({
    threadId: input.threadId,
    cwd: input.cwd,
    hostPath: requiredEnv("LUME_NODE_REPL_HOST"),
    kernelPath: join(rootPath, "runtime", "kernel-process.js"),
    nodePath: process.env.LUME_NODE_REPL_ELECTRON?.trim() || process.execPath
  });
}

export class JsonlNodeReplRuntimeClient implements NodeReplRuntimeClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<string, PendingCall>();
  private stderr = "";

  constructor(private readonly options: JsonlNodeReplRuntimeClientOptions) {}

  async exec(input: JsExecInput): Promise<NodeReplExecutionResult> {
    const value = await this.call("exec", {
      code: input.code,
      ...(input.timeout_ms ? { timeout_ms: input.timeout_ms } : {}),
      ...(input._meta ? { request_meta: input._meta } : {})
    }, callTimeoutMs(input.timeout_ms));
    return mapExecutionValue(value);
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

  private async call(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
    this.ensureStarted();
    const child = this.child;
    if (!child || !child.stdin.writable) {
      throw new Error("node_repl runtime stdin unavailable");
    }

    const requestId = `node-repl-${this.nextId++}`;
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
      child.stdin.write(`${payload}\n`, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  private ensureStarted(): void {
    if (this.child) return;

    const child = spawn(this.options.hostPath, [
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
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_REPL_HOST_PATH: this.options.hostPath,
        NODE_REPL_KERNEL_PATH: this.options.kernelPath,
        NODE_REPL_NODE_PATH: this.options.nodePath,
        NODE_REPL_SESSION_ID: this.options.threadId
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;

    createInterface({ input: child.stdout }).on("line", (line) => {
      this.handleLine(line);
    });
    child.stderr.on("data", (chunk) => {
      this.stderr = truncate(`${this.stderr}${chunk.toString("utf8")}`, MAX_STDERR_CHARS);
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

    let message: RuntimeControlResponse;
    try {
      message = JSON.parse(trimmed) as RuntimeControlResponse;
    } catch {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

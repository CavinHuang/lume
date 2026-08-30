export const NODE_REPL_MCP_INSTRUCTIONS =
  'Use `js` only for an explicitly requested persistent JS session. Do not use it as a terminal, shell, git, file search, or file editing tool; use Read, Write, Edit, Bash, Glob, or Grep for repository work. Top-level bindings persist across calls within the thread runtime. Bare final expressions are not returned; call `nodeRepl.write(text)` to include output and use `JSON.stringify(value)` for structured values. Agent tools: await tools.NAME(params) (or await tools.call("NAME", params)) invokes the agent\'s own tools with normal permission checks; await tools.documentation() lists them.';

export interface JsExecInput {
  title?: string;
  code: string;
  timeout_ms?: number;
  _meta?: Record<string, unknown>;
}

export type NodeReplContentBlock =
  | { type: "text"; text: string; _meta?: Record<string, unknown> }
  | { type: "image"; data: string; mimeType: string; _meta?: Record<string, unknown> }
  | {
    type: "image";
    source: { type: "file"; path: string; media_type: string };
    _meta?: Record<string, unknown>;
  };

export interface NodeReplExecutionResult {
  content: NodeReplContentBlock[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface NodeReplComputerUseRequest {
  method: string;
  params: Record<string, unknown>;
}

export interface NodeReplComputerUseResult {
  value: unknown;
  content?: NodeReplContentBlock[];
  meta?: Record<string, unknown>;
}

export interface NodeReplRuntimeExecOptions {
  sandbox?: SandboxSettings;
  emitComputerUseRequest?: (request: NodeReplComputerUseRequest, signal: AbortSignal) => Promise<NodeReplComputerUseResult>;
  toolRequest?: (request: { method: "tool_call" | "tool_list"; args: Record<string, unknown> }, signal: AbortSignal) => Promise<unknown>;
}

export interface NodeReplRuntimeClient {
  exec(input: JsExecInput, options?: NodeReplRuntimeExecOptions): Promise<NodeReplExecutionResult>;
  addNodeModuleDirectory(dir: string): Promise<boolean>;
  reset(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface RuntimeFactoryInput {
  threadId: string;
  cwd: string;
  sandbox?: SandboxSettings;
}

export type RuntimeFactory = (input: RuntimeFactoryInput) => NodeReplRuntimeClient | Promise<NodeReplRuntimeClient>;

export interface NodeReplRuntimeRegistry {
  addModuleDir(threadId: string, dir: string, options?: { cwd?: string; sandbox?: SandboxSettings }): Promise<boolean>;
  exec(threadId: string, input: JsExecInput, options?: { cwd?: string } & NodeReplRuntimeExecOptions): Promise<NodeReplExecutionResult>;
  reset(threadId: string, options?: { cwd?: string; sandbox?: SandboxSettings }): Promise<void>;
  shutdown(threadId: string): Promise<void>;
  /** 关闭全部 thread 沙箱（sidecar 退出时用；thread 级清理走 shutdown） */
  shutdownAll?(): Promise<void>;
  debugSnapshot(threadId: string): { moduleDirs: string[]; cwd: string } | null;
}
import type { SandboxSettings } from "@lume/agent-sdk";

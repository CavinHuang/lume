export const NODE_REPL_MCP_INSTRUCTIONS =
  "Use `js` to run JavaScript in the persistent Node-backed kernel. Top-level bindings persist across calls until `js_reset`.";

export interface JsExecInput {
  title?: string;
  code: string;
  timeout_ms?: number;
  _meta?: Record<string, unknown>;
}

export type NodeReplContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; _meta?: Record<string, unknown> };

export interface NodeReplExecutionResult {
  content: NodeReplContentBlock[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface NodeReplRuntimeClient {
  exec(input: JsExecInput): Promise<NodeReplExecutionResult>;
  addNodeModuleDirectory(dir: string): Promise<boolean>;
  reset(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface RuntimeFactoryInput {
  threadId: string;
  cwd: string;
}

export type RuntimeFactory = (input: RuntimeFactoryInput) => NodeReplRuntimeClient | Promise<NodeReplRuntimeClient>;

export interface NodeReplRuntimeRegistry {
  addModuleDir(threadId: string, dir: string, options?: { cwd?: string }): Promise<boolean>;
  exec(threadId: string, input: JsExecInput, options?: { cwd?: string }): Promise<NodeReplExecutionResult>;
  reset(threadId: string, options?: { cwd?: string }): Promise<void>;
  shutdown(threadId: string): Promise<void>;
  debugSnapshot(threadId: string): { moduleDirs: string[]; cwd: string } | null;
}

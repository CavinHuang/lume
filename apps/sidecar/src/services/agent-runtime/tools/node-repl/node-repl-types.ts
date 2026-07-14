export const NODE_REPL_MCP_INSTRUCTIONS =
  "Use `js` to run JavaScript in the persistent Node-backed kernel. Top-level bindings persist across calls until `js_reset`. Bare final expressions are not returned; call `nodeRepl.write(text)` to include output and use `JSON.stringify(value)` for structured values.";

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

export interface NodeReplBrowserAuthRequest {
  context?: {
    threadId?: string;
    browserSessionId?: string;
    browserTurnId?: string;
  };
  tabId?: string;
  origin?: string;
  reason?: string;
  expires_at?: string;
  fields?: Array<{
    id?: string;
    label?: string;
    type?: string;
    autocomplete?: string;
    required?: boolean;
  }>;
}

export interface NodeReplBrowserAuthResult {
  status: "approved" | "declined" | "cancelled" | "unavailable" | "expired" | "origin_changed" | "page_changed" | "locator_invalid" | "submission_failed";
  values?: Record<string, string>;
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
  emitBrowserAuthRequest?: (request: NodeReplBrowserAuthRequest, signal: AbortSignal) => Promise<NodeReplBrowserAuthResult>;
  emitComputerUseRequest?: (request: NodeReplComputerUseRequest, signal: AbortSignal) => Promise<NodeReplComputerUseResult>;
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
}

export type RuntimeFactory = (input: RuntimeFactoryInput) => NodeReplRuntimeClient | Promise<NodeReplRuntimeClient>;

export interface NodeReplRuntimeRegistry {
  addModuleDir(threadId: string, dir: string, options?: { cwd?: string }): Promise<boolean>;
  exec(threadId: string, input: JsExecInput, options?: { cwd?: string } & NodeReplRuntimeExecOptions): Promise<NodeReplExecutionResult>;
  reset(threadId: string, options?: { cwd?: string }): Promise<void>;
  shutdown(threadId: string): Promise<void>;
  debugSnapshot(threadId: string): { moduleDirs: string[]; cwd: string } | null;
}

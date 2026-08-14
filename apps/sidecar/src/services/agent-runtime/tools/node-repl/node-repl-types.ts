export const NODE_REPL_MCP_INSTRUCTIONS =
  'Use `js` only for browser JavaScript automation or an explicitly requested persistent JS session. Do not use it as a terminal, shell, git, file search, or file editing tool; use Read, Write, Edit, Bash, Glob, or Grep for repository work. Top-level bindings persist across calls until `js_reset`. Bare final expressions are not returned; call `nodeRepl.write(text)` to include output and use `JSON.stringify(value)` for structured values. Browser automation: run `globalThis.agent ??= await setupBrowserRuntime()` once, then `globalThis.iab ??= await agent.browsers.get("iab")`; call `nodeRepl.write(await iab.documentation())` for the full browser API (tabs, playwright locators, cua, capabilities). `tab.screenshot()` auto-emits the image to you. Reuse existing globalThis.agent/iab/browser bindings across turns.';

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

import type { BrowserAuthOption, BrowserLocator } from "@lume/shared";

export interface NodeReplBrowserAuthRequest {
  context?: {
    threadId?: string;
    browserSessionId?: string;
    browserTurnId?: string;
  };
  tabId?: string;
  generation?: number;
  origin?: string;
  reason?: string;
  expires_at?: string;
  fields?: Array<{
    id?: string;
    label?: string;
    type?: string;
    autocomplete?: string;
    required?: boolean;
    locator?: BrowserLocator;
    frameLocator?: BrowserLocator;
  }>;
  options?: BrowserAuthOption[];
  submit?:
    | { kind: "click"; locator: BrowserLocator; frameLocator?: BrowserLocator }
    | { kind: "press_enter"; fieldId?: string }
    | { kind: "none" };
}

export interface NodeReplBrowserAuthResult {
  status: "submitted" | "declined" | "cancelled" | "unavailable" | "expired" | "origin_changed" | "page_changed" | "locator_invalid" | "submission_failed";
  selected_option?: string;
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
  emitBrowserAuthRequest?: (request: NodeReplBrowserAuthRequest, signal: AbortSignal) => Promise<NodeReplBrowserAuthResult>;
  emitComputerUseRequest?: (request: NodeReplComputerUseRequest, signal: AbortSignal) => Promise<NodeReplComputerUseResult>;
  browserRequest?: (request: { method: string; params: Record<string, unknown> }, signal: AbortSignal) => Promise<unknown>;
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
  debugSnapshot(threadId: string): { moduleDirs: string[]; cwd: string } | null;
}
import type { SandboxSettings } from "@lume/agent-sdk";

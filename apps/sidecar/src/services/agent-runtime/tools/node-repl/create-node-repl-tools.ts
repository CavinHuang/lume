import { basename, isAbsolute, win32 } from "node:path";
import type { ToolDefinition, ToolResult } from "@lume/agent-sdk";
import type { AgentBrowserAuthRequest, McpServerStatus, McpToolDetail } from "@lume/shared";
import { getNodeReplRuntimeRegistry } from "./node-repl-runtime-registry";
import {
  NODE_REPL_MCP_INSTRUCTIONS,
  type JsExecInput,
  type NodeReplBrowserAuthRequest,
  type NodeReplBrowserAuthResult,
  type NodeReplComputerUseRequest,
  type NodeReplComputerUseResult,
  type NodeReplRuntimeRegistry
} from "./node-repl-types";
import { waitForBrowserAuthResponse } from "../../interruption/browser-auth-session";

export const NODE_REPL_MCP_SERVER_ID = "node_repl";
export const NODE_REPL_MCP_SERVER_NAME = "node_repl";
const NODE_REPL_MCP_WRAPPER_PREFIX = `mcp__${NODE_REPL_MCP_SERVER_ID}__`;

export function createNodeReplTools(input: {
  sessionId: string;
  cwd: string;
  workspaceSlug?: string;
  emitBrowserAuthRequest?: (request: AgentBrowserAuthRequest) => void;
  emitComputerUseRequest?: (request: NodeReplComputerUseRequest, signal: AbortSignal) => Promise<NodeReplComputerUseResult>;
  registry?: NodeReplRuntimeRegistry;
}): ToolDefinition[] {
  const registry = input.registry ?? getNodeReplRuntimeRegistry();
  const runtimeMetadata = {
    source: "lume",
    category: "execute",
    capability: "external",
    riskLevel: "high",
    sideEffects: "process",
    allowedInPlanMode: true,
    isReadOnly: false,
    isConcurrencySafe: false,
    requiresApprovalByDefault: false,
    executionPolicy: { allowBackground: false }
  };

  return [
    {
      name: "js",
      description: NODE_REPL_MCP_INSTRUCTIONS,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          code: { type: "string" },
          timeout_ms: { type: "number" },
          _meta: { type: "object", additionalProperties: true }
        },
        required: ["code"]
      },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      isEnabled: () => true,
      async prompt() {
        return NODE_REPL_MCP_INSTRUCTIONS;
      },
      runtimeMetadata,
      async call(rawArgs, context) {
        const parsed = parseJsExecInput(rawArgs);
        if (!parsed.ok) return errorResult(context.toolUseId, parsed.error);
        const threadId = context.sessionId ?? input.sessionId;
        const execInput = withRuntimeRequestMeta(parsed.value, {
          threadId,
          toolUseId: context.toolUseId
        });
        const result = await registry.exec(threadId, execInput, {
          cwd: context.cwd || input.cwd,
          emitBrowserAuthRequest: input.emitBrowserAuthRequest
            ? (request, signal) => resolveBrowserAuthRequest({
              request,
              signal,
              threadId,
              toolUseId: context.toolUseId,
              emit: input.emitBrowserAuthRequest!,
            })
            : undefined,
          emitComputerUseRequest: input.emitComputerUseRequest,
        });
        return {
          type: "tool_result",
          tool_use_id: context.toolUseId ?? "",
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
          ...(result._meta ? { _meta: result._meta } : {})
        } as ToolResult & { _meta?: Record<string, unknown> };
      }
    },
    {
      name: "js_reset",
      description: "Reset persistent JS bindings for the current thread runtime.",
      inputSchema: { type: "object", properties: {} },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      isEnabled: () => true,
      async prompt() {
        return "Reset persistent JS bindings for the current thread runtime.";
      },
      runtimeMetadata: {
        ...runtimeMetadata,
        category: "control",
        riskLevel: "low",
        sideEffects: "none"
      },
      async call(_args, context) {
        const threadId = context.sessionId ?? input.sessionId;
        await registry.reset(threadId, { cwd: context.cwd || input.cwd });
        return { type: "tool_result", tool_use_id: context.toolUseId ?? "", content: "ok" };
      }
    },
    {
      name: "js_add_node_module_dir",
      description: "Register an absolute node_modules directory for future dynamic imports.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" }
        },
        required: ["path"]
      },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      isEnabled: () => true,
      async prompt() {
        return "Register an absolute node_modules directory for future dynamic imports.";
      },
      runtimeMetadata: {
        ...runtimeMetadata,
        category: "control",
        riskLevel: "medium"
      },
      async call(rawArgs, context) {
        const dir = readPath(rawArgs);
        if (!dir) return errorResult(context.toolUseId, "path must be a non-empty string");
        if (!isAbsolutePath(dir)) return errorResult(context.toolUseId, "path must be an absolute node_modules directory");
        if (!isNodeModulesDirectory(dir)) return errorResult(context.toolUseId, "path must end with node_modules");

        const threadId = context.sessionId ?? input.sessionId;
        const added = await registry.addModuleDir(threadId, dir, { cwd: context.cwd || input.cwd });
        return { type: "tool_result", tool_use_id: context.toolUseId ?? "", content: String(added) };
      }
    }
  ];
}

export function createNodeReplMcpTools(input: {
  sessionId: string;
  cwd: string;
  workspaceSlug?: string;
  emitBrowserAuthRequest?: (request: AgentBrowserAuthRequest) => void;
  emitComputerUseRequest?: (request: NodeReplComputerUseRequest, signal: AbortSignal) => Promise<NodeReplComputerUseResult>;
  registry?: NodeReplRuntimeRegistry;
}): ToolDefinition[] {
  return createNodeReplTools(input).map((tool) => ({
    ...tool,
    name: toNodeReplMcpWrapperName(tool.name),
    runtimeMetadata: {
      ...(tool.runtimeMetadata ?? {}),
      source: "mcp",
      capability: "mcp",
      mcpServerId: NODE_REPL_MCP_SERVER_ID,
      builtin: true
    }
  }));
}

export function getNodeReplMcpToolDetails(cwd = process.cwd()): McpToolDetail[] {
  return createNodeReplTools({ sessionId: "node_repl-status", cwd }).map((tool) => ({
    name: toNodeReplMcpWrapperName(tool.name),
    originalName: tool.name,
    wrapperName: toNodeReplMcpWrapperName(tool.name),
    description: tool.description,
    inputSchema: tool.inputSchema,
    serverId: NODE_REPL_MCP_SERVER_ID,
    serverName: NODE_REPL_MCP_SERVER_NAME
  }));
}

export function getNodeReplMcpStatus(now = Date.now()): McpServerStatus {
  const toolDetails = getNodeReplMcpToolDetails();
  return {
    serverId: NODE_REPL_MCP_SERVER_ID,
    name: NODE_REPL_MCP_SERVER_NAME,
    transport: "stdio",
    enabled: true,
    status: "connected",
    tools: toolDetails.map((tool) => tool.wrapperName),
    toolDetails,
    lastCheckedAt: now,
    lastConnectedAt: now
  };
}

function toNodeReplMcpWrapperName(toolName: string): string {
  return `${NODE_REPL_MCP_WRAPPER_PREFIX}${toolName}`;
}

function parseJsExecInput(rawArgs: unknown): { ok: true; value: JsExecInput } | { ok: false; error: string } {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return { ok: false, error: "input must be an object" };
  }
  const args = rawArgs as Record<string, unknown>;
  if (typeof args.code !== "string" || args.code.trim().length === 0) {
    return { ok: false, error: "code must be a non-empty string" };
  }
  if (args.timeout_ms !== undefined && (!Number.isFinite(args.timeout_ms) || Number(args.timeout_ms) <= 0)) {
    return { ok: false, error: "timeout_ms must be a positive number" };
  }
  return {
    ok: true,
    value: {
      code: args.code,
      ...(typeof args.title === "string" ? { title: args.title } : {}),
      ...(typeof args.timeout_ms === "number" ? { timeout_ms: args.timeout_ms } : {}),
      ...(isRecord(args._meta) ? { _meta: args._meta } : {})
    }
  };
}

function withRuntimeRequestMeta(input: JsExecInput, runtime: { threadId: string; toolUseId?: string }): JsExecInput {
  return {
    ...input,
    _meta: {
      sessionId: runtime.threadId,
      threadId: runtime.threadId,
      ...(runtime.toolUseId ? { toolUseId: runtime.toolUseId } : {}),
      ...(input._meta ?? {})
    }
  };
}

let browserAuthRequestSeq = 1;

async function resolveBrowserAuthRequest(input: {
  request: NodeReplBrowserAuthRequest;
  signal: AbortSignal;
  threadId: string;
  toolUseId?: string;
  emit: (request: AgentBrowserAuthRequest) => void;
}): Promise<NodeReplBrowserAuthResult> {
  const normalized = normalizeBrowserAuthRequest(input.request, input.threadId, input.toolUseId);
  if (!normalized) return { status: "unavailable" };
  const result = await waitForBrowserAuthResponse(normalized, input.signal, input.emit);
  if (result.status === "submitted") {
    return { status: "approved", values: result.values ?? {} };
  }
  return { status: result.status };
}

function normalizeBrowserAuthRequest(
  request: NodeReplBrowserAuthRequest,
  fallbackThreadId: string,
  toolUseId?: string,
): AgentBrowserAuthRequest | null {
  const origin = typeof request.origin === "string" ? request.origin.trim() : "";
  if (!origin) return null;
  const fields = Array.isArray(request.fields) ? request.fields : [];
  return {
    threadId: request.context?.threadId || fallbackThreadId,
    requestId: `browser_auth:${toolUseId ?? "node_repl"}:${browserAuthRequestSeq++}`,
    origin,
    ...(typeof request.reason === "string" && request.reason.trim() ? { reason: request.reason.trim() } : {}),
    expiresAt: typeof request.expires_at === "string" && request.expires_at.trim()
      ? request.expires_at
      : new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    fields: fields.map((field, index) => ({
      id: typeof field.id === "string" && field.id.trim() ? field.id : `field-${index + 1}`,
      label: typeof field.label === "string" && field.label.trim() ? field.label : `Field ${index + 1}`,
      type: typeof field.type === "string" && field.type.trim() ? field.type : "text",
      ...(typeof field.autocomplete === "string" && field.autocomplete.trim() ? { autocomplete: field.autocomplete } : {}),
      ...(field.required !== undefined ? { required: field.required === true } : {})
    })),
    ...(request.context?.browserSessionId ? { browserSessionId: request.context.browserSessionId } : {}),
    ...(request.context?.browserTurnId ? { browserTurnId: request.context.browserTurnId } : {}),
    ...(typeof request.tabId === "string" && request.tabId.trim() ? { tabId: request.tabId } : {})
  };
}

function readPath(rawArgs: unknown): string | null {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return null;
  const value = (rawArgs as Record<string, unknown>).path;
  return typeof value === "string" && value.trim() ? value : null;
}

function isAbsolutePath(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path);
}

function isNodeModulesDirectory(path: string): boolean {
  const trimmed = path.replace(/[\\/]+$/, "");
  return basename(trimmed) === "node_modules" || win32.basename(trimmed) === "node_modules";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function errorResult(toolUseId: string | undefined, content: string): ToolResult {
  return {
    type: "tool_result",
    tool_use_id: toolUseId ?? "",
    content,
    is_error: true
  };
}

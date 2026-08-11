import type { ToolDefinition, ToolResult } from "@lume/agent-sdk";
import type { AgentToolPermissionRequest, LinkActionDetail, LinkAuthorizationSignal } from "@lume/shared";
import { randomUUID } from "node:crypto";
import { callLinkMcpTool, isLinkRuntimeOnline, LinkApiError, type McpLinkPayload } from "../../../link/link-client";
import { waitForToolPermissionDecision } from "../../interruption/tool-permission-session";

const SAFE_ACTION_VERBS = new Set(["get", "list", "search", "find", "fetch", "read", "query", "lookup", "check", "describe", "count", "status"]);
const UNSAFE_ACTION_VERBS = new Set([
  "add", "set", "upsert", "create", "update", "replace", "delete", "remove", "send", "post", "put", "patch",
  "write", "modify", "invite", "transfer", "pay", "publish", "execute", "run", "start", "stop", "cancel", "close",
  "archive", "restore", "move", "rename", "upload", "submit", "approve", "merge", "enable", "disable", "grant",
  "revoke", "reply", "comment", "commit", "deploy", "trigger", "schedule",
]);
const AUTH_CODES = new Set([
  "connection_not_found", "connection_required", "credential_expired", "credential_verification_failed",
  "oauth_client_config_required", "oauth_token_expired", "oauth_refresh_unavailable", "oauth_token_refresh_failed",
  "authorization_failed", "scope_missing", "app_not_found", "app_not_ready",
]);

let activeCalls = 0;
const callWaiters: Array<() => void> = [];

type McpCaller = (toolName: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<McpLinkPayload>;

export function createLinkTools(input: {
  threadId: string;
  runId?: string;
  emitToolPermissionRequest: (request: AgentToolPermissionRequest) => void;
  mcpCaller?: McpCaller;
  preferredConnections?: Readonly<Record<string, string>>;
  promoteToActiveSchema?: boolean;
}): ToolDefinition[] {
  if (!isLinkRuntimeOnline()) return [];
  const mcpCaller = input.mcpCaller ?? callLinkMcpTool;
  const inspectedActions = new Map<string, LinkActionDetail>();
  const readMetadata = metadata(true, true, input.promoteToActiveSchema === true);
  return [
    definition("link_list_apps", "List locally configured OpenConnector apps. Optionally filter by service.", {
      type: "object", properties: { service: { type: "string" } }, additionalProperties: false,
    }, readMetadata, async (args, context) => {
      const service = optionalString(args.service);
      const payload = await mcpCaller("list_apps", service ? { query: service } : {}, context.abortSignal);
      if (!payload.ok) throw new LinkApiError(payload.error.code, payload.error.message);
      const apps = Array.isArray(payload.data) ? payload.data : [];
      const filtered = service ? apps.filter((app: Record<string, unknown>) => app?.service === service) : apps;
      return result(context.toolUseId, filtered);
    }),
    definition("link_search_actions", "Search OpenConnector actions. Inspect an action before calling it.", {
      type: "object",
      properties: { query: { type: "string" }, service: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 50 } },
      required: ["query"], additionalProperties: false,
    }, readMetadata, async (args, context) => {
      const query = requiredString(args.query, "query");
      const service = optionalString(args.service);
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
      const payload = await mcpCaller("search_actions", { query, ...(service ? { service } : {}), limit }, context.abortSignal);
      if (!payload.ok) throw new LinkApiError(payload.error.code, payload.error.message);
      return result(context.toolUseId, payload.data);
    }),
    definition("link_inspect_actions", "Inspect one or more OpenConnector action schemas and authorization requirements.", {
      type: "object",
      properties: {
        actions: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
        connectionName: { type: "string" },
      },
      required: ["actions"], additionalProperties: false,
    }, readMetadata, async (args, context) => {
      const actionIds: string[] = Array.isArray(args.actions) ? args.actions.map((value: unknown) => requiredString(value, "action")) : [];
      if (!actionIds.length) throw new Error("actions is required");
      const connectionName = optionalString(args.connectionName) || preferredConnectionForActions(actionIds, input.preferredConnections);
      const details = await Promise.all(actionIds.map(async (actionId: string) => {
        const payload = await mcpCaller("get_action_guide", { actionId, ...(connectionName ? { connectionName } : {}) }, context.abortSignal);
        if (!payload.ok) throw new LinkApiError(payload.error.code, payload.error.message);
        const detail = actionDetailFromGuide(actionId, payload.data);
        inspectedActions.set(inspectionKey(actionId, connectionName), detail);
        return { ...detail, lumeRisk: classifyAction(detail) };
      }));
      return result(context.toolUseId, details);
    }),
    definition("link_call_action", "Call an inspected OpenConnector action using an exact service, action, and optional named connection.", {
      type: "object",
      properties: {
        service: { type: "string" }, action: { type: "string" }, input: { type: "object" }, connectionName: { type: "string" },
      },
      required: ["service", "action", "input"], additionalProperties: false,
    }, metadata(false, false, input.promoteToActiveSchema === true), async (args, context) => {
      const service = requiredString(args.service, "service");
      const action = requiredString(args.action, "action");
      const connectionName = optionalString(args.connectionName) || input.preferredConnections?.[service] || "";
      const detail = inspectedActions.get(inspectionKey(action, connectionName));
      if (!detail) throw new Error("inspection_required");
      if (detail.service !== service) throw new Error("link_action_service_mismatch");
      const risk = classifyAction(detail);
      if (risk !== "read") {
        const request: AgentToolPermissionRequest = {
          threadId: input.threadId,
          ...(input.runId ? { runId: input.runId } : {}),
          requestId: randomUUID(),
          toolUseId: context.toolUseId ?? randomUUID(),
          toolName: "link_call_action",
          risk: "high",
          reason: `OpenConnector action ${service}.${action} may change external data.`,
          reasonCode: "link_external_write_or_unknown",
          canAllowAlways: false,
          input: { service, action, ...(connectionName ? { connectionName } : {}) },
        };
        const signal = context.abortSignal ?? new AbortController().signal;
        const decision = await waitForToolPermissionDecision(request, signal, input.emitToolPermissionRequest);
        if (decision !== "allow_once") throw new Error("link_action_not_approved");
      }
      const release = await acquireCallSlot(context.abortSignal);
      const startedAt = Date.now();
      try {
        const payload = await mcpCaller("execute_action", { actionId: action, input: asRecord(args.input), ...(connectionName ? { connectionName } : {}) }, context.abortSignal);
        if (!payload.ok) throw new LinkApiError(payload.error.code, payload.error.message);
        return result(context.toolUseId, {
          service,
          action,
          ...(connectionName ? { connectionName } : {}),
          durationMs: Date.now() - startedAt,
          result: payload.data,
        });
      } catch (error) {
        if (error instanceof LinkApiError && AUTH_CODES.has(error.code)) {
          const authorization: LinkAuthorizationSignal = {
            kind: "link_authorization_required", service, actionId: action, threadId: input.threadId,
            ...(connectionName ? { connectionName } : {}), errorCode: error.code,
          };
          return result(context.toolUseId, { error: error.message, authorization }, true, { link: authorization });
        }
        throw error;
      } finally {
        release();
      }
    }),
  ];
}

function actionDetailFromGuide(actionId: string, data: unknown): LinkActionDetail {
  const record = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const capability = record.capability && typeof record.capability === "object" && !Array.isArray(record.capability)
    ? record.capability as Record<string, unknown>
    : {};
  const segments = actionId.split(".");
  const service = typeof record.service === "string" ? record.service : segments[0] ?? actionId;
  const name = typeof record.name === "string"
    ? record.name
    : segments.length > 1 ? segments.slice(1).join(".") : actionId;
  const requiredScopes = stringArray(capability.requiredScopes);
  const providerPermissions = stringArray(capability.providerPermissions);
  return {
    id: typeof record.id === "string" ? record.id : actionId,
    service,
    name,
    ...(record.readOnly === true ? { readOnly: true } : {}),
    ...(typeof record.markdown === "string" ? { markdown: record.markdown } : {}),
    ...(requiredScopes ? { requiredScopes } : {}),
    ...(providerPermissions ? { providerPermissions } : {}),
  };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((item): item is string => typeof item === "string");
  return filtered.length ? filtered : undefined;
}

export function classifyAction(action: LinkActionDetail): "read" | "write_or_unknown" {
  if (action.readOnly === true) return "read";
  const identifiers = [action.name, action.id.split(".").at(-1) ?? action.id];
  const tokenGroups = identifiers.map(actionTokens);
  if (tokenGroups.some((tokens) => tokens.some((token) => UNSAFE_ACTION_VERBS.has(token)))) return "write_or_unknown";
  return tokenGroups.some((tokens) => tokens[0] && SAFE_ACTION_VERBS.has(tokens[0])) ? "read" : "write_or_unknown";
}

function actionTokens(value: string): string[] {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function definition(name: string, description: string, inputSchema: ToolDefinition["inputSchema"], runtimeMetadata: Record<string, unknown>, call: ToolDefinition["call"]): ToolDefinition {
  return { name, description, inputSchema, runtimeMetadata, isEnabled: () => true, isReadOnly: () => name !== "link_call_action", isConcurrencySafe: () => name !== "link_call_action", prompt: async () => description, call };
}
function metadata(readOnly: boolean, allowedInPlanMode: boolean, requiredDuringSkillScope = false): Record<string, unknown> {
  return { source: "link", title: "OpenConnector Link", category: "network", capability: "link", riskLevel: "low", sideEffects: "external", allowedInPlanMode, isReadOnly: readOnly, isConcurrencySafe: readOnly, requiresNetwork: true, requiresApprovalByDefault: false, ...(requiredDuringSkillScope ? { requiredDuringSkillScope: true } : {}) };
}
function result(toolUseId: string | undefined, data: unknown, isError = false, meta?: Record<string, unknown>): ToolResult {
  return { type: "tool_result", tool_use_id: toolUseId ?? "", content: JSON.stringify(data, null, 2), ...(isError ? { is_error: true } : {}), ...(meta ? { _meta: meta } : {}) };
}
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function requiredString(value: unknown, label: string): string { const text = optionalString(value); if (!text) throw new Error(`${label} is required`); return text; }
function optionalString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function inspectionKey(action: string, connectionName: string): string { return `${action}\u0000${connectionName || "default"}`; }
function preferredConnectionForActions(actionIds: string[], preferredConnections?: Readonly<Record<string, string>>): string {
  const services = new Set(actionIds.map((actionId) => actionId.split(".")[0]).filter(Boolean));
  if (services.size !== 1) return "";
  const service = services.values().next().value;
  return service ? preferredConnections?.[service] ?? "" : "";
}
async function acquireCallSlot(signal?: AbortSignal): Promise<() => void> {
  if (activeCalls >= 2) await new Promise<void>((resolve, reject) => {
    const resume = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
    const onAbort = () => { const index = callWaiters.indexOf(resume); if (index >= 0) callWaiters.splice(index, 1); reject(new Error("link_call_aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    callWaiters.push(resume);
  });
  activeCalls += 1;
  return () => { activeCalls -= 1; callWaiters.shift()?.(); };
}

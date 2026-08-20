import { randomUUID } from "node:crypto"
import type { ToolDefinition, ToolInputSchema, ToolResult } from "@lume/agent-sdk"
import type { BrowserBackendDescriptor, BrowserTabDescriptor } from "@lume/shared"
import type { BrowserBroker } from "../../../browser/browser-broker"
import { getActiveBrowserBroker } from "../../../browser/browser-broker-holder"
import { getBrowserToolSessionRegistry, type BrowserToolSessionRegistry } from "./browser-tool-session"

export const BROWSER_MCP_SERVER_ID = "browser"
const WRAPPER_PREFIX = `mcp__${BROWSER_MCP_SERVER_ID}__`
export const BROWSER_TOOL_NAMES = ["list_tabs", "open", "switch_tab", "snapshot"] as const
export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number]

type BrowserToolBroker = Pick<BrowserBroker, "dispatch" | "listBackends">

export function createBrowserMcpTools(input: {
  broker?: BrowserToolBroker
  sessionRegistry?: BrowserToolSessionRegistry
  threadId: string
}): ToolDefinition[] {
  const session = (input.sessionRegistry ?? getBrowserToolSessionRegistry()).getOrCreate(input.threadId)
  const resolveBroker = (): BrowserToolBroker => {
    const broker = input.broker ?? getActiveBrowserBroker()
    if (!broker) throw new Error("browser_unavailable")
    return broker
  }
  const dispatch = (broker: BrowserToolBroker, method: string, params?: Record<string, unknown>) => broker.dispatch({
    method,
    ...(params ? { params } : {}),
    threadId: input.threadId,
    browserSessionId: session.browserSessionId,
    browserTurnId: session.browserTurnId,
  })

  return BROWSER_TOOL_NAMES.map((name) => {
    const readOnly = name === "list_tabs" || name === "snapshot"
    return {
      name: `${WRAPPER_PREFIX}${name}`,
      description: describeTool(name),
      inputSchema: toolSchema(name),
      isReadOnly: () => readOnly,
      isConcurrencySafe: () => false,
      isEnabled: () => {
        try { return resolveBroker().listBackends().some((backend: BrowserBackendDescriptor) => backend.backend === "iab") } catch { return false }
      },
      async prompt() { return describeTool(name) },
      runtimeMetadata: {
        source: "mcp",
        category: readOnly ? "read" : "execute",
        capability: "mcp",
        riskLevel: name === "open" ? "medium" : "low",
        sideEffects: name === "open" ? "desktop" : "none",
        allowedInPlanMode: readOnly,
        isReadOnly: readOnly,
        isConcurrencySafe: false,
        requiresApprovalByDefault: false,
        executionPolicy: { allowBackground: false },
        mcpServerId: BROWSER_MCP_SERVER_ID,
        builtin: true,
      },
      async call(rawArgs, context) {
        const operationId = context.toolUseId || randomUUID()
        try {
          const broker = resolveBroker()
          const args = asRecord(rawArgs)
          const result = await executeTool(name, args, broker, dispatch, session)
          return toolResult(operationId, {
            ok: true,
            operation_id: operationId,
            session_id: session.browserSessionId,
            ...result,
          })
        } catch (error) {
          const code = browserErrorCode(error)
          return toolResult(operationId, {
            ok: false,
            operation_id: operationId,
            code,
            message: code,
            retryable: code === "browser_unavailable" || code === "stale_target",
          }, true)
        }
      },
    } satisfies ToolDefinition
  })
}

async function executeTool(
  name: BrowserToolName,
  args: Record<string, unknown>,
  broker: BrowserToolBroker,
  dispatch: (broker: BrowserToolBroker, method: string, params?: Record<string, unknown>) => Promise<unknown>,
  session: ReturnType<BrowserToolSessionRegistry["getOrCreate"]>,
): Promise<Record<string, unknown>> {
  if (name === "open") {
    const url = stringValue(args.url)
    if (!url) throw new Error("invalid_url")
    const tab = await dispatch(broker, "create_tab", { options: { url } }) as BrowserTabDescriptor
    session.activeTabId = tab.tabId
    return { active_tab_id: tab.tabId, tab }
  }

  const tabs = await ownedAgentTabs(broker, dispatch, session.threadId)
  const activeTab = reconcileActiveTab(session, tabs)
  if (name === "list_tabs") return { active_tab_id: activeTab?.tabId ?? null, tabs }
  if (name === "switch_tab") {
    const tabId = stringValue(args.tab_id)
    const tab = tabId ? tabs.find((candidate) => candidate.tabId === tabId) : undefined
    if (!tab) throw new Error("tab_not_found")
    session.activeTabId = tab.tabId
    return { active_tab_id: tab.tabId, tab }
  }
  if (!activeTab) throw new Error("tab_not_found")
  const snapshot = await dispatch(broker, "browser_snapshot", {
    tabId: activeTab.tabId,
    interactive_only: args.interactive_only === true,
    ...(stringValue(args.cursor) ? { cursor: stringValue(args.cursor) } : {}),
    ...(Number.isInteger(args.limit) ? { limit: args.limit } : {}),
  })
  return { active_tab_id: activeTab.tabId, observation: snapshot }
}

async function ownedAgentTabs(
  broker: BrowserToolBroker,
  dispatch: (broker: BrowserToolBroker, method: string, params?: Record<string, unknown>) => Promise<unknown>,
  threadId: string,
): Promise<BrowserTabDescriptor[]> {
  const result = await dispatch(broker, "list_tabs")
  if (!Array.isArray(result)) throw new Error("browser_internal_error")
  return result
    .filter((value): value is BrowserTabDescriptor => Boolean(value) && typeof value === "object" && !Array.isArray(value))
    .filter((tab) => tab.backend === "iab" && tab.profileKind === "agent" && tab.ownerThreadId === threadId)
    .sort((left, right) => Number(right.visible) - Number(left.visible)
      || String(right.lastOpenedAt ?? "").localeCompare(String(left.lastOpenedAt ?? "")))
}

function reconcileActiveTab(session: ReturnType<BrowserToolSessionRegistry["getOrCreate"]>, tabs: BrowserTabDescriptor[]): BrowserTabDescriptor | undefined {
  const active = tabs.find((tab) => tab.tabId === session.activeTabId) ?? tabs[0]
  session.activeTabId = active?.tabId
  return active
}

function toolSchema(name: BrowserToolName): ToolInputSchema {
  const object = (properties: Record<string, unknown>, required: string[] = []) => ({
    type: "object" as const,
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  })
  if (name === "open") return object({ url: { type: "string", description: "HTTP(S) URL to open in a new Agent-owned tab." } }, ["url"])
  if (name === "switch_tab") return object({ tab_id: { type: "string", description: "Agent-owned tab_id returned by list_tabs or open." } }, ["tab_id"])
  if (name === "snapshot") return object({
    interactive_only: { type: "boolean", default: false, description: "Return only interactive nodes and their semantic ancestors." },
    cursor: { type: "string", description: "Opaque next_cursor returned by the previous snapshot page." },
    limit: { type: "integer", minimum: 50, maximum: 1000, default: 400, description: "Maximum semantic-tree lines in this page." },
  })
  return object({})
}

function describeTool(name: BrowserToolName): string {
  return ({
    list_tabs: "List only tabs owned by this Agent task and show the locked active tab.",
    open: "Open a URL in a new Agent-owned in-app browser tab and lock subsequent browser tools to it.",
    switch_tab: "Explicitly switch the Agent's locked browser target to another Agent-owned tab.",
    snapshot: "Read the active tab as a compact accessibility-tree snapshot. Interactive nodes have refs such as [ref=e12]; later browser actions use @e12. Call this before interacting. Continue large snapshots with next_cursor.",
  })[name]
}

function browserErrorCode(error: unknown): string {
  const structured = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : ""
  const message = structured || (error instanceof Error ? error.message : String(error ?? ""))
  return /^[a-z][a-z0-9_]{1,80}$/.test(message) ? message : "browser_internal_error"
}

function toolResult(toolUseId: string, value: unknown, isError = false): ToolResult {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: JSON.stringify(value),
    ...(isError ? { is_error: true } : {}),
  }
}

function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }

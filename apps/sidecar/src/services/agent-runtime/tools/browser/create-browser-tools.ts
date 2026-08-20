import { randomUUID } from "node:crypto"
import type { ToolDefinition, ToolInputSchema, ToolResult } from "@lume/agent-sdk"
import type { BrowserBackendDescriptor, BrowserTabDescriptor } from "@lume/shared"
import type { BrowserBroker } from "../../../browser/browser-broker"
import { getActiveBrowserBroker } from "../../../browser/browser-broker-holder"
import { getBrowserToolSessionRegistry, type BrowserToolSessionRegistry } from "./browser-tool-session"

export const BROWSER_MCP_SERVER_ID = "browser"
const WRAPPER_PREFIX = `mcp__${BROWSER_MCP_SERVER_ID}__`
export const BROWSER_TOOL_NAMES = ["list_tabs", "open", "switch_tab", "snapshot", "run_script"] as const
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
        riskLevel: name === "run_script" ? "high" : name === "open" ? "medium" : "low",
        sideEffects: name === "open" || name === "run_script" ? "desktop" : "none",
        allowedInPlanMode: readOnly,
        isReadOnly: readOnly,
        isConcurrencySafe: false,
        requiresApprovalByDefault: false,
        executionPolicy: { allowBackground: false },
        resultPolicy: { maxChars: 50_000 },
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
          }, false, repeatGuardState(name, result))
        } catch (error) {
          const code = browserErrorCode(error)
          const message = error instanceof Error && error.message && error.message !== code ? error.message.slice(0, 4_000) : code
          return toolResult(operationId, {
            ok: false,
            operation_id: operationId,
            code,
            message,
            retryable: code === "browser_unavailable" || code === "stale_target",
          }, true, { ok: false, tool: name, code, message })
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
  if (name === "run_script") {
    const script = stringValue(args.script)
    if (!script || script.length > 50_000) throw new Error("invalid_browser_request")
    const execution = await dispatch(broker, "browser_run_script", {
      tabId: activeTab.tabId,
      script,
      arg: args.arg ?? null,
      ...(Number.isInteger(args.timeout_ms) ? { timeout_ms: args.timeout_ms } : {}),
    }) as { status?: unknown; value?: unknown; exception?: unknown }
    if (execution?.status === "exception") {
      const exception = asRecord(execution.exception)
      const message = typeof exception.message === "string" ? exception.message.slice(0, 4_000) : "Script execution failed"
      throw Object.assign(new Error(message), { code: "script_exception" })
    }
    if (execution?.status !== "completed") throw new Error("browser_internal_error")
    return { active_tab_id: activeTab.tabId, value: execution.value ?? null }
  }
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
  if (name === "run_script") return object({
    script: { type: "string", maxLength: 50000, description: "JavaScript function body. Use arg for JSON input and return a JSON-serializable value." },
    arg: { description: "Optional JSON-serializable value exposed to the script as arg." },
    timeout_ms: { type: "integer", minimum: 100, maximum: 10000, default: 5000, description: "Execution timeout in milliseconds." },
  }, ["script"])
  return object({})
}

function describeTool(name: BrowserToolName): string {
  return ({
    list_tabs: "List only tabs owned by this Agent task and show the locked active tab.",
    open: "Open a URL in a new Agent-owned in-app browser tab and lock subsequent browser tools to it.",
    switch_tab: "Explicitly switch the Agent's locked browser target to another Agent-owned tab.",
    snapshot: "Read the active tab as a compact accessibility-tree snapshot. Interactive nodes have refs such as [ref=e12]; later browser actions use @e12. Call this before interacting. Continue large snapshots with next_cursor.",
    run_script: "Run a bounded JavaScript function body in an isolated world on the locked Agent tab. The script receives JSON input as arg and must return a JSON-serializable value. Prefer semantic Browser tools for ordinary interaction. Script execution requires the browser action confirmation gate.",
  })[name]
}

function browserErrorCode(error: unknown): string {
  const structured = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : ""
  const message = structured || (error instanceof Error ? error.message : String(error ?? ""))
  return /^[a-z][a-z0-9_]{1,80}$/.test(message) ? message : "browser_internal_error"
}

function repeatGuardState(name: BrowserToolName, result: Record<string, unknown>): unknown {
  if (name === "open" || name === "switch_tab") {
    const tab = asRecord(result.tab)
    return {
      ok: true,
      tool: name,
      url: tab.url ?? null,
      title: tab.title ?? null,
      generation: tab.generation ?? null,
    }
  }
  if (name === "run_script") return { ok: true, tool: name, value: result.value ?? null }
  return result
}

function toolResult(toolUseId: string, value: unknown, isError = false, repeatState?: unknown): ToolResult {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: JSON.stringify(value),
    ...(isError ? { is_error: true } : {}),
    ...(repeatState !== undefined ? { _meta: { repeatGuard: { state: repeatState } } } : {}),
  }
}

function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }

import { randomUUID } from "node:crypto"
import { withRepeatGuardState } from "@lume/agent-sdk"
import type { ToolDefinition, ToolInputSchema, ToolResult } from "@lume/agent-sdk"
import {
  BROWSER_MCP_SERVER_ID,
  BROWSER_TOOL_NAME_PREFIX,
  type BrowserBackendDescriptor,
  type BrowserTabDescriptor,
} from "@lume/shared"
import { BROWSER_HANDLER_WAIT_CAP_MS } from "@lume/shared"
// #601 维护性 review：工具名唯一真源在 @lume/shared（LUME_BROWSER_TOOL_NAMES）——
// 新增工具时 shared 一处登记，web 映射哨兵测试自动盯住
import { LUME_BROWSER_TOOL_NAMES as BROWSER_TOOL_NAMES } from "@lume/shared"
import type { BrowserBroker } from "../../../browser/browser-broker"
import { getActiveBrowserBroker } from "../../../browser/browser-broker-holder"
import { getBrowserToolSessionRegistry, type BrowserToolSessionRegistry } from "./browser-tool-session"

const WRAPPER_PREFIX = BROWSER_TOOL_NAME_PREFIX
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
    const readOnly = name === "list_tabs" || name === "snapshot" || name === "screenshot" || name === "list_secrets" || name === "dialog"
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
        riskLevel: name === "run_script" || name === "fill_secret" ? "high" : name === "open" || name === "upload" || name === "download" ? "medium" : "low",
        sideEffects: readOnly ? "none" : "desktop",
        allowedInPlanMode: readOnly,
        isReadOnly: readOnly,
        isConcurrencySafe: false,
        requiresApprovalByDefault: false,
        executionPolicy: { allowBackground: false },
        resultPolicy: { maxChars: 50_000 },
        mcpServerId: BROWSER_MCP_SERVER_ID,
        builtin: true,
        // 任务级常驻工具（系统提示词承诺全程直接调用），必须留在 core 注入池而非 deferred 池，
        // 否则未经历 ToolSearch 提升的工具会报 Unknown tool（link 工具同模式）
        requiredDuringSkillScope: true,
      },
      async call(rawArgs, context) {
        const operationId = context.toolUseId || randomUUID()
        const args = asRecord(rawArgs)
        if ((isActionTool(name) || session.blockedActionLoop?.tool === name) && session.blockedActionLoop) {
          const blocked = session.blockedActionLoop
          return toolResult(operationId, {
            ok: false,
            operation_id: operationId,
            active_tab_id: session.activeTabId ?? null,
            code: "repeated_action_failure",
            message: `Browser actions stopped after ${blocked.tool} repeatedly failed with ${blocked.code}${blocked.ref ? ` on @${blocked.ref}` : ""}. Do not retry browser actions until the page navigates or the user intervenes.`,
            retryable: false,
          }, true, { ok: false, tool: name, code: "repeated_action_failure", blocked_by: blocked.tool, ...(blocked.ref ? { ref: blocked.ref } : {}) })
        }
        try {
          const broker = resolveBroker()
          const result = await executeTool(name, args, broker, dispatch, session)
          if (name === "open" || name === "switch_tab" || isNavigationTool(name) || name === "handle_dialog") clearActionFailures(session)
          const failureKey = actionFailureKey(name, args, session)
          if (failureKey === session.lastNonRetryableActionFailure?.key) session.lastNonRetryableActionFailure = undefined
          if (name === "screenshot") return screenshotToolResult(operationId, session.browserSessionId, result)
          return toolResult(operationId, {
            ok: true,
            operation_id: operationId,
            session_id: session.browserSessionId,
            ...result,
          }, false, repeatGuardState(name, result, args))
        } catch (error) {
          const code = browserErrorCode(error)
          if (code === "stale_target" || code === "stale_snapshot_cursor" || code === "tab_not_found" || code === "user_takeover_required") session.snapshot = undefined
          const message = error instanceof Error && error.message && error.message !== code ? error.message.slice(0, 4_000) : code
          // broker 已把 desktop 富文本摧毁为裸码,navigation_timeout 的行为
          // 指导只能在此注入:页面可能仍在后台加载,先观察再决定。
          // user_declined 同理(#601 端到端 review B1):用户否决不随参数/ref 变化,
          // 不给指引模型会「换个姿势重试」再次弹窗骚扰。
          const hint = code === "navigation_timeout"
            ? "The page may still be loading in the background. Take a snapshot to check the actual state before deciding; do not retry navigate immediately. If it times out again, open a new tab or report this to the user instead of retrying."
            : code === "user_declined"
              ? "The user explicitly declined this action in the confirmation dialog. Do NOT retry it with different parameters, selectors, or refs—the refusal is about the action itself, not its formulation. Ask the user how they would like to proceed."
              : undefined
          const retryable = code === "browser_unavailable" || code === "stale_target" || code === "stale_snapshot_cursor"
          const failureKey = !retryable ? actionFailureKey(name, args, session) : undefined
          if (failureKey) {
            const previous = session.lastNonRetryableActionFailure
            const current = session.lastNonRetryableActionFailure = {
              attempts: previous?.key === failureKey ? previous.attempts + 1 : 1,
              code,
              key: failureKey,
            }
            if (current.attempts >= 2) {
              // #661：非 ref 工具（run_script/upload/download/fill_secret）无 snapshot 也可置位，
              // generation 取 0——任何后续真实快照都会因代际不符解锁，与既有解除路径一致。
              session.blockedActionLoop = {
                code,
                generation: session.snapshot?.generation ?? 0,
                ...(typeof args.ref === "string" ? { ref: args.ref.replace(/^@/, "") } : {}),
                tabId: session.snapshot?.tabId ?? session.activeTabId ?? "",
                tool: name,
              }
            }
          }
          return toolResult(operationId, {
            ok: false,
            operation_id: operationId,
            active_tab_id: session.activeTabId ?? null,
            code,
            message: hint ? `${message}. ${hint}` : message,
            retryable,
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
    // broker 对 create_tab 的返回做 extension 协议归一化为 { id }，须解出 tabId
    const created = asRecord(await dispatch(broker, "create_tab", { options: { url } }))
    const createdTab = asRecord(created.tab) as unknown as BrowserTabDescriptor | null
    const tabId = stringValue(created.id) || stringValue(createdTab?.tabId)
    if (!tabId) throw new Error("browser_internal_error")
    session.activeTabId = tabId
    session.snapshot = undefined
    return { active_tab_id: tabId, tab: createdTab?.tabId ? createdTab : { id: tabId } }
  }

  const tabs = await ownedAgentTabs(broker, dispatch, session.threadId)
  const activeTab = reconcileActiveTab(session, tabs)
  if (name === "list_tabs") return { active_tab_id: activeTab?.tabId ?? null, tabs }
  if (name === "switch_tab") {
    const tabId = stringValue(args.tab_id)
    const tab = tabId ? tabs.find((candidate) => candidate.tabId === tabId) : undefined
    if (!tab) throw new Error("tab_not_found")
    session.activeTabId = tab.tabId
    session.snapshot = undefined
    return { active_tab_id: tab.tabId, tab }
  }
  if (!activeTab) throw new Error("tab_not_found")
  if (name === "dialog") {
    // broker 对 tab_get_js_dialog 的返回归一化为 { dialog }，须解包
    const dialogResult = asRecord(await dispatch(broker, "tab_get_js_dialog", { tabId: activeTab.tabId }))
    return { active_tab_id: activeTab.tabId, dialog: dialogResult.dialog ?? null }
  }
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
  if (name === "screenshot") {
    const fullPage = args.full_page === true
    const annotated = args.annotated === true
    if (annotated && fullPage) throw new Error("invalid_browser_request")
    if (annotated && !session.snapshot) throw new Error("snapshot_required")
    const screenshot = asRecord(await dispatch(broker, "tab_screenshot", {
      tabId: activeTab.tabId,
      fullPage,
      annotated,
      ...(annotated ? { semanticSnapshotId: session.snapshot!.snapshotId } : {}),
    }))
    const data = stringValue(screenshot.data)
    if (!data) throw new Error("browser_internal_error")
    return {
      active_tab_id: activeTab.tabId,
      image: { data, media_type: fullPage || annotated ? "image/png" : "image/jpeg" },
      full_page: fullPage,
      annotated,
      ...(annotated ? {
        snapshot_id: session.snapshot!.snapshotId,
        annotated_refs: Array.isArray(screenshot.annotated_refs) ? screenshot.annotated_refs : [],
      } : {}),
    }
  }
  if (name === "list_secrets") {
    return { active_tab_id: activeTab.tabId, secrets: await dispatch(broker, "browser_list_secrets", { tabId: activeTab.tabId }) }
  }
  if (isNavigationTool(name)) {
    const url = name === "navigate" ? stringValue(args.url) : undefined
    if (name === "navigate" && !url) throw new Error("invalid_url")
    const navigation = await dispatch(broker, navigationBrokerMethod(name), {
      tabId: activeTab.tabId,
      ...(url ? { url } : {}),
    })
    // 导航调用在 loadURL 完成后才返回，effect:navigation 是既成事实而非预测
    return observeAfterMutation(activeTab.tabId, { ...(asRecord(navigation)), effect: "navigation" }, broker, dispatch, session)
  }
  if (name === "handle_dialog") {
    const dialogId = stringValue(args.dialog_id)
    if (!dialogId) throw new Error("invalid_browser_request")
    const action = await dispatch(broker, "tab_handle_js_dialog", {
      tabId: activeTab.tabId,
      dialog_id: dialogId,
      action: args.accept === false ? "dismiss" : "accept",
      ...(typeof args.prompt_text === "string" ? { prompt_text: args.prompt_text } : {}),
    })
    return observeAfterMutation(activeTab.tabId, action, broker, dispatch, session)
  }
  if (name === "upload") {
    const target = semanticTarget(session, activeTab, args.ref)
    const files = Array.isArray(args.files) ? args.files.filter((value): value is string => Boolean(stringValue(value))) : []
    if (!files.length || files.length > 20) throw new Error("invalid_browser_request")
    const timeoutMs = boundedTimeout(args.timeout_ms)
    const chooserPromise = dispatch(broker, "playwright_wait_for_file_chooser", { tabId: activeTab.tabId, timeout_ms: timeoutMs })
    const [chooser, click] = await Promise.all([
      chooserPromise,
      dispatch(broker, "playwright_locator_click", {
        tabId: activeTab.tabId,
        locator: target.locator,
        semanticRef: target.refId,
        semanticSnapshotId: target.snapshotId,
        semanticIntent: `${target.ref.role} ${target.ref.name}`.trim(),
      }),
    ])
    const chooserId = stringValue(asRecord(chooser).file_chooser_id)
    if (!chooserId) throw new Error("browser_internal_error")
    // 单文件 input 传多个文件会被页面静默丢弃，须在设置前明确拒绝
    if (files.length > 1 && asRecord(chooser).is_multiple !== true) {
      throw Object.assign(new Error("file input accepts a single file"), { code: "invalid_browser_request" })
    }
    // input 声明 accept 时拒绝类型不匹配的路径文件；browser-download 引用文件名在 desktop 侧，此处放行
    const acceptedTypes = stringValue(asRecord(chooser).accept)
    if (acceptedTypes) {
      const rejected = files.find((file) => !file.startsWith("browser-download:") && !matchesAcceptedFileTypes(file, acceptedTypes))
      if (rejected) {
        throw Object.assign(
          new Error(`upload rejected: ${rejected.split(/[\\/]/).pop()} does not match the file input's accepted types (${acceptedTypes})`),
          { code: "invalid_browser_request" },
        )
      }
    }
    const upload = await dispatch(broker, "playwright_file_chooser_set_files", {
      tabId: activeTab.tabId,
      file_chooser_id: chooserId,
      files,
    })
    return observeAfterMutation(activeTab.tabId, { click, upload, count: files.length }, broker, dispatch, session)
  }
  if (name === "download") {
    // 查询模式：对既有 download_id 只读状态，不重复点击触发下载
    const existingId = stringValue(args.download_id)
    if (existingId) {
      const resolved = asRecord(await dispatch(broker, "playwright_download_path", {
        tabId: activeTab.tabId,
        download_id: existingId,
        timeout_ms: boundedTimeout(args.timeout_ms),
      }))
      const fileRef = stringValue(resolved.path)
      return {
        active_tab_id: activeTab.tabId,
        download_id: existingId,
        state: fileRef ? "completed" : stringValue(resolved.state) || "in_progress",
        file_ref: fileRef || null,
        ...downloadMetadata(resolved),
      }
    }
    const target = semanticTarget(session, activeTab, args.ref)
    const timeoutMs = boundedTimeout(args.timeout_ms)
    const downloadPromise = dispatch(broker, "playwright_wait_for_download", { tabId: activeTab.tabId, timeout_ms: timeoutMs })
    const [download, click] = await Promise.all([
      downloadPromise,
      dispatch(broker, "playwright_locator_click", {
        tabId: activeTab.tabId,
        locator: target.locator,
        semanticRef: target.refId,
        semanticSnapshotId: target.snapshotId,
        semanticIntent: `${target.ref.role} ${target.ref.name}`.trim(),
      }),
    ])
    const downloadId = stringValue(asRecord(download).download_id)
    if (!downloadId) throw new Error("browser_internal_error")
    const resolved = asRecord(await dispatch(broker, "playwright_download_path", {
      tabId: activeTab.tabId,
      download_id: downloadId,
      timeout_ms: timeoutMs,
    }))
    const fileRef = stringValue(resolved.path)
    const state = stringValue(resolved.state)
    // 超时未拿到终态 → 下载仍在进行：点击已成功，不误报 download_failed，模型可用 download_id 查询
    if (!fileRef && (!state || state === "pending")) {
      return observeAfterMutation(activeTab.tabId, { click, download_id: downloadId, state: "in_progress", ...downloadMetadata(resolved) }, broker, dispatch, session)
    }
    if (!fileRef) throw Object.assign(new Error(`download ${state}`), { code: "download_failed" })
    return observeAfterMutation(activeTab.tabId, { click, download_id: downloadId, file_ref: fileRef, state: "completed", ...downloadMetadata(resolved) }, broker, dispatch, session)
  }
  if (name === "fill_secret") {
    const target = semanticTarget(session, activeTab, args.ref)
    const secretId = stringValue(args.secret_id)
    if (!secretId) throw new Error("invalid_browser_request")
    const action = await dispatch(broker, "browser_fill_secret", {
      tabId: activeTab.tabId,
      secret_id: secretId,
      locator: target.locator,
      semanticRef: target.refId,
      semanticSnapshotId: target.snapshotId,
      semanticIntent: `${target.ref.role} ${target.ref.name}`.trim(),
    })
    return observeAfterMutation(activeTab.tabId, action, broker, dispatch, session)
  }
  if (isActionTool(name)) {
    const target = semanticTarget(session, activeTab, args.ref)
    const action = await dispatch(broker, actionBrokerMethod(name, args), {
      tabId: activeTab.tabId,
      locator: target.locator,
      semanticRef: target.refId,
      semanticSnapshotId: target.snapshotId,
      semanticIntent: `${target.ref.role} ${target.ref.name}`.trim(),
      ...actionParams(name, args),
    })
    return observeAfterMutation(activeTab.tabId, action, broker, dispatch, session)
  }
  const scopeRef = stringValue(args.scope_ref)
  if (scopeRef && !session.snapshot) throw new Error("stale_target")
  const snapshot = await dispatch(broker, "browser_snapshot", {
    tabId: activeTab.tabId,
    interactive_only: args.interactive_only === true,
    ...(scopeRef ? { scope_ref: scopeRef, snapshot_id: session.snapshot!.snapshotId } : {}),
    ...(stringValue(args.cursor) ? { cursor: stringValue(args.cursor) } : {}),
    ...(Number.isInteger(args.limit) ? { limit: args.limit } : {}),
  })
  rememberSnapshot(session, snapshot, Boolean(stringValue(args.cursor) || scopeRef))
  return { active_tab_id: activeTab.tabId, observation: snapshot }
}

async function ownedAgentTabs(
  broker: BrowserToolBroker,
  dispatch: (broker: BrowserToolBroker, method: string, params?: Record<string, unknown>) => Promise<unknown>,
  threadId: string,
): Promise<BrowserTabDescriptor[]> {
  const result = await dispatch(broker, "list_tabs")
  // broker 对 list_tabs 的返回做 extension 协议归一化为 { tabs }，须解包
  const wrapped = asRecord(result).tabs
  if (!Array.isArray(result) && !Array.isArray(wrapped)) throw new Error("browser_internal_error")
  const list: unknown[] = Array.isArray(result) ? result : wrapped as unknown[]
  if (!list) throw new Error("browser_internal_error")
  return list
    .filter((value): value is BrowserTabDescriptor => Boolean(value) && typeof value === "object" && !Array.isArray(value))
    .filter((tab) => tab.backend === "iab" && tab.profileKind === "agent" && tab.ownerThreadId === threadId)
    .sort((left, right) => Number(right.visible) - Number(left.visible)
      || String(right.lastOpenedAt ?? "").localeCompare(String(left.lastOpenedAt ?? "")))
}

function reconcileActiveTab(session: ReturnType<BrowserToolSessionRegistry["getOrCreate"]>, tabs: BrowserTabDescriptor[]): BrowserTabDescriptor | undefined {
  const active = session.activeTabId ? tabs.find((tab) => tab.tabId === session.activeTabId) : tabs[0]
  if (session.activeTabId && !active) session.snapshot = undefined
  if (!session.activeTabId) session.activeTabId = active?.tabId
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
  if (name === "navigate") return object({ url: { type: "string", description: "HTTP(S) URL to load in the locked Agent tab." } }, ["url"])
  if (name === "snapshot") return object({
    interactive_only: { type: "boolean", default: false, description: "Return only interactive nodes and their semantic ancestors." },
    scope_ref: { type: "string", pattern: "^@?e[1-9][0-9]*$", description: "Return only the subtree rooted at a ref from the previous snapshot." },
    cursor: { type: "string", description: "Opaque next_cursor returned by the previous snapshot page." },
    limit: { type: "integer", minimum: 50, maximum: 1000, default: 400, description: "Maximum semantic-tree lines in this page." },
  })
  if (name === "screenshot") return object({
    full_page: { type: "boolean", default: false, description: "Capture the full scrollable page instead of the current viewport." },
    annotated: { type: "boolean", default: false, description: "Label visible elements with refs from the latest snapshot. Requires snapshot first and cannot be combined with full_page." },
  })
  if (name === "upload") return object({
    ref: refSchema(),
    files: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" }, description: "Task-authorized file paths or browser-download file refs." },
    timeout_ms: { type: "integer", minimum: 100, maximum: BROWSER_HANDLER_WAIT_CAP_MS, default: 10000 },
  }, ["ref", "files"])
  if (name === "download") return object({
    ref: refSchema(),
    download_id: { type: "string", description: "Query the state of an existing download instead of clicking a new control. Provide either download_id or ref." },
    timeout_ms: { type: "integer", minimum: 100, maximum: BROWSER_HANDLER_WAIT_CAP_MS, default: 10000 },
  })
  if (name === "fill_secret") return object({
    ref: refSchema(),
    secret_id: { type: "string", maxLength: 200, description: "Credential id returned by list_secrets for the current site." },
  }, ["ref", "secret_id"])
  if (name === "click") return object({ ref: refSchema() }, ["ref"])
  if (name === "double_click") return object({ ref: refSchema() }, ["ref"])
  if (name === "hover") return object({ ref: refSchema() }, ["ref"])
  if (name === "fill") return object({
    ref: refSchema(),
    text: { type: "string", maxLength: 100000, description: "Replacement text for the editable element." },
  }, ["ref", "text"])
  if (name === "type") return object({
    ref: refSchema(),
    text: { type: "string", maxLength: 100000, description: "Text to append to the editable element." },
  }, ["ref", "text"])
  if (name === "press") return object({
    ref: refSchema(),
    key: { type: "string", maxLength: 100, description: "Key or chord, for example Enter, Tab, or Control+A." },
  }, ["ref", "key"])
  if (name === "select") return object({
    ref: refSchema(),
    value: { type: "string", maxLength: 10000, description: "Option value to select." },
  }, ["ref", "value"])
  if (name === "check") return object({
    ref: refSchema(),
    checked: { type: "boolean", default: true, description: "Desired checked state." },
  }, ["ref"])
  if (name === "scroll") return object({
    ref: refSchema(),
    delta_x: { type: "number", minimum: -10000, maximum: 10000, default: 0 },
    delta_y: { type: "number", minimum: -10000, maximum: 10000, description: "Vertical wheel distance; positive scrolls down." },
  }, ["ref", "delta_y"])
  if (name === "handle_dialog") return object({
    dialog_id: { type: "string", description: "Dialog id returned by the dialog tool." },
    accept: { type: "boolean", default: true },
    prompt_text: { type: "string", maxLength: 10000, description: "Optional text for a prompt dialog." },
  }, ["dialog_id"])
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
    navigate: "Navigate the locked Agent tab to a URL, then return a fresh interactive snapshot.",
    back: "Go back in the locked Agent tab, then return a fresh interactive snapshot.",
    forward: "Go forward in the locked Agent tab, then return a fresh interactive snapshot.",
    reload: "Reload the locked Agent tab, then return a fresh interactive snapshot.",
    snapshot: "Read the active tab as a compact accessibility-tree snapshot. Interactive nodes have refs such as [ref=e12]; later browser actions use @e12. Call this before interacting. Continue large snapshots with next_cursor.",
    click: "Click an element from the latest snapshot by ref, then return a fresh interactive snapshot.",
    double_click: "Double-click an element from the latest snapshot by ref, then return a fresh interactive snapshot.",
    hover: "Hover an element from the latest snapshot by ref, then return a fresh interactive snapshot.",
    fill: "Replace the value of an editable element from the latest snapshot, then return a fresh interactive snapshot.",
    type: "Append text to an editable element from the latest snapshot, then return a fresh interactive snapshot.",
    press: "Press a key or chord on an element from the latest snapshot, then return a fresh interactive snapshot.",
    select: "Select an option value on a control from the latest snapshot, then return a fresh interactive snapshot.",
    check: "Set the checked state of a checkbox or radio from the latest snapshot, then return a fresh interactive snapshot.",
    scroll: "Scroll at an element from the latest snapshot, then return a fresh interactive snapshot.",
    screenshot: "Capture the locked Agent tab as an image for visual inspection. Set annotated=true after snapshot to label visible elements with the same refs used by semantic actions. Screenshots are observation only.",
    upload: "Click a file control from the latest snapshot, wait for its chooser, and upload task-authorized files as one coordinated operation. Files must match the control's accepted types. Requires confirmation.",
    download: "Click a download control from the latest snapshot and wait for the resulting download; returns state in_progress with a download_id when the timeout expires first — re-call with only download_id to poll. Downloaded files return as task-scoped browser-download file refs.",
    list_secrets: "List saved credential metadata available for the locked tab's exact origin. Secret values are never returned.",
    fill_secret: "Fill a saved secret into an editable ref without exposing the value to the model, transcript, trace, or tool arguments. Requires confirmation.",
    dialog: "Read the JavaScript dialog currently blocking the locked Agent tab, if any.",
    handle_dialog: "Accept or dismiss the current JavaScript dialog, then return a fresh interactive snapshot.",
    run_script: "Run a bounded JavaScript function body in an isolated world on the locked Agent tab. The script receives JSON input as arg and must return a JSON-serializable value. Prefer semantic Browser tools for ordinary interaction. Script execution requires the browser action confirmation gate.",
  })[name]
}

function browserErrorCode(error: unknown): string {
  const structured = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : ""
  const message = structured || (error instanceof Error ? error.message : String(error ?? ""))
  return /^[a-z][a-z0-9_]{1,80}$/.test(message) ? message : "browser_internal_error"
}

function repeatGuardState(name: BrowserToolName, result: Record<string, unknown>, args: Record<string, unknown> = {}): unknown {
  if (name === "open" || name === "switch_tab") {
    // create_tab 经 broker 归一化只剩 id，url 以工具入参为准
    const tab = asRecord(result.tab)
    return {
      ok: true,
      tool: name,
      url: stringValue(args.url) || tab.url || null,
      title: tab.title ?? null,
      generation: tab.generation ?? null,
    }
  }
  if (name === "snapshot") {
    const observation = asRecord(result.observation)
    return {
      ok: true,
      tool: name,
      tab_id: observation.tab_id ?? null,
      generation: observation.navigation_generation ?? null,
      tree: observation.tree ?? null,
    }
  }
  if (name === "run_script") return { ok: true, tool: name, value: result.value ?? null }
  if (isActionTool(name) || name === "upload" || name === "download") {
    const observation = asRecord(result.observation)
    const action = asRecord(result.action)
    return {
      ok: true,
      tool: name,
      ...(name === "upload" ? { count: action.count ?? null } : {}),
      ...(name === "download" ? { file_ref: action.file_ref ?? null } : {}),
      requires_snapshot: result.requires_snapshot === true,
      snapshot_id: observation.snapshot_id ?? null,
      generation: observation.navigation_generation ?? null,
      tree: observation.tree ?? null,
    }
  }
  return result
}

type BrowserActionToolName = "click" | "double_click" | "hover" | "fill" | "type" | "press" | "select" | "check" | "scroll"
type BrowserNavigationToolName = "navigate" | "back" | "forward" | "reload"

function isActionTool(name: BrowserToolName): name is BrowserActionToolName {
  return new Set<BrowserToolName>(["click", "double_click", "hover", "fill", "type", "press", "select", "check", "scroll"]).has(name)
}

function isNavigationTool(name: BrowserToolName): name is BrowserNavigationToolName {
  return name === "navigate" || name === "back" || name === "forward" || name === "reload"
}

function refSchema(): Record<string, unknown> {
  return { type: "string", pattern: "^@?e[1-9][0-9]*$", description: "Element ref from the latest snapshot, for example @e12." }
}

function semanticTarget(
  session: ReturnType<BrowserToolSessionRegistry["getOrCreate"]>,
  tab: BrowserTabDescriptor,
  value: unknown,
): { locator: { version: 1; steps: Array<Record<string, unknown>> }; ref: { name: string; nth?: number; role: string }; refId: string; snapshotId: string } {
  const key = stringValue(value)?.replace(/^@/, "")
  const snapshot = session.snapshot
  if (!key || !snapshot || snapshot.tabId !== tab.tabId || snapshot.generation !== tab.generation) throw new Error("stale_target")
  const ref = snapshot.refs[key]
  if (!ref) throw new Error("stale_target")
  return {
    ref,
    refId: key,
    snapshotId: snapshot.snapshotId,
    locator: {
      version: 1,
      steps: [
        { kind: "role", role: ref.role, ...(ref.name ? { name: ref.name, exact: true } : {}) },
        ...(ref.nth !== undefined ? [{ kind: "nth", index: ref.nth }] : []),
      ],
    },
  }
}

function actionBrokerMethod(name: BrowserActionToolName, args: Record<string, unknown>): string {
  if (name === "click") return "playwright_locator_click"
  if (name === "double_click") return "playwright_locator_dblclick"
  if (name === "hover") return "playwright_locator_hover"
  if (name === "fill") return "playwright_locator_fill"
  if (name === "type") return "playwright_locator_type"
  if (name === "press") return "playwright_locator_press"
  if (name === "select") return "playwright_locator_select_option"
  if (name === "check") return args.checked === false ? "playwright_locator_uncheck" : "playwright_locator_check"
  return "playwright_locator_scroll"
}

function actionParams(name: BrowserActionToolName, args: Record<string, unknown>): Record<string, unknown> {
  if (name === "fill" || name === "type") return { text: String(args.text ?? "") }
  if (name === "press") return { key: String(args.key ?? "Enter") }
  if (name === "select") return { value: String(args.value ?? "") }
  if (name === "scroll") return { deltaX: finiteNumber(args.delta_x), deltaY: finiteNumber(args.delta_y) }
  return {}
}

function navigationBrokerMethod(name: BrowserNavigationToolName): string {
  if (name === "navigate") return "navigate_tab_url"
  if (name === "back") return "navigate_tab_back"
  if (name === "forward") return "navigate_tab_forward"
  return "navigate_tab_reload"
}

/** 下载状态查询的只读元数据：来源/文件名/MIME/大小，供模型判断产物与进度 */
function downloadMetadata(resolved: Record<string, unknown>): Record<string, unknown> {
  const filename = stringValue(resolved.filename)
  const mimeType = stringValue(resolved.mime_type)
  const origin = stringValue(resolved.origin)
  return {
    ...(filename ? { filename } : {}),
    ...(mimeType ? { mime_type: mimeType } : {}),
    ...(origin ? { origin } : {}),
    ...(Number.isFinite(resolved.total_bytes) ? { total_bytes: resolved.total_bytes } : {}),
    ...(Number.isFinite(resolved.received_bytes) ? { received_bytes: resolved.received_bytes } : {}),
  }
}

/** accept token（扩展名/通配 MIME/常见精确 MIME）到扩展名集合的映射；未收录的精确 MIME 放行避免误拒 */
const ACCEPTED_TYPE_EXTENSIONS: Record<string, ReadonlySet<string>> = {
  "image/*": new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico", "heic"]),
  "video/*": new Set(["mp4", "webm", "mov", "avi", "mkv", "m4v"]),
  "audio/*": new Set(["mp3", "wav", "ogg", "flac", "aac", "m4a", "opus"]),
  "application/pdf": new Set(["pdf"]),
  "text/plain": new Set(["txt"]),
  "text/csv": new Set(["csv"]),
  "application/json": new Set(["json"]),
  "application/zip": new Set(["zip"]),
}

function matchesAcceptedFileTypes(file: string, accept: string): boolean {
  const tokens = accept.split(",").map((token) => token.trim().toLowerCase()).filter(Boolean)
  if (!tokens.length) return true
  const extension = (file.split(/[\\/]/).pop() ?? "").toLowerCase()
  const suffix = extension.slice(extension.lastIndexOf(".") + 1)
  return tokens.some((token) => token.startsWith(".")
    ? suffix === token.slice(1)
    : ACCEPTED_TYPE_EXTENSIONS[token]?.has(suffix) === true)
}

async function observeAfterMutation(
  tabId: string,
  action: unknown,
  broker: BrowserToolBroker,
  dispatch: (broker: BrowserToolBroker, method: string, params?: Record<string, unknown>) => Promise<unknown>,
  session: ReturnType<BrowserToolSessionRegistry["getOrCreate"]>,
): Promise<Record<string, unknown>> {
  // #604：desktop 已确认无可检测变化（含 domRevision 未动）时页面未变，上次快照的 refs 仍然
  // 有效（generation 未变），跳过全量 AX 重扫与 400 行观察倾倒；导航类 effect 恒为字符串标签不受影响。
  // effect 形态兼容对象（desktop 检测结果 {kind}）与字符串（navigate 分支的既成事实标签）。
  const effect = asRecord(asRecord(action).click ?? action).effect
  const effectKind = typeof effect === "string" ? effect : asRecord(effect).kind
  if (session.snapshot && session.snapshot.tabId === tabId && effectKind === "no_detectable_change") {
    return { active_tab_id: tabId, action, observation_unchanged: true }
  }
  try {
    const observation = await dispatch(broker, "browser_snapshot", { tabId, interactive_only: true, limit: 400 })
    rememberSnapshot(session, observation)
    return { active_tab_id: tabId, action, observation }
  } catch (error) {
    session.snapshot = undefined
    return {
      active_tab_id: tabId,
      action,
      observation: null,
      observation_error: browserErrorCode(error),
      requires_snapshot: true,
    }
  }
}

function rememberSnapshot(
  session: ReturnType<BrowserToolSessionRegistry["getOrCreate"]>,
  value: unknown,
  append = false,
): void {
  const observation = asRecord(value)
  const snapshotId = stringValue(observation.snapshot_id)
  const tabId = stringValue(observation.tab_id)
  const generation = Number(observation.navigation_generation)
  if (!snapshotId || !tabId || !Number.isInteger(generation)) throw new Error("browser_internal_error")
  const blocked = session.blockedActionLoop
  if (blocked && (blocked.tabId !== tabId || blocked.generation !== generation)) clearActionFailures(session)
  const refs = Object.fromEntries(Object.entries(asRecord(observation.refs)).flatMap(([key, raw]) => {
    const ref = asRecord(raw)
    const role = stringValue(ref.role)
    if (!/^e[1-9][0-9]*$/.test(key) || !role || typeof ref.name !== "string") return []
    const nth = Number.isInteger(ref.nth) && Number(ref.nth) >= 0 ? Number(ref.nth) : undefined
    return [[key, { role, name: ref.name, ...(nth !== undefined ? { nth } : {}) }]]
  }))
  const previous = append && session.snapshot?.snapshotId === snapshotId ? session.snapshot.refs : {}
  session.snapshot = { snapshotId, tabId, generation, refs: { ...previous, ...refs } }
}

function actionFailureKey(
  name: BrowserToolName,
  args: Record<string, unknown>,
  session: ReturnType<BrowserToolSessionRegistry["getOrCreate"]>,
): string | undefined {
  const ref = isActionTool(name) ? stringValue(args.ref)?.replace(/^@/, "") : undefined
  const snapshot = session.snapshot
  if (ref && snapshot) return JSON.stringify([name, ref, snapshot.tabId, snapshot.generation])
  // #661：非输入类工具（run_script/upload/download/fill_secret 等）无 ref 键可计，
  // 按 [tool, tabId] 累计连拒/连败，≥2 同样熔断，防止确认真窗被无限重弹。
  if (!ref) {
    const tabId = snapshot?.tabId ?? session.activeTabId
    return tabId ? JSON.stringify([name, null, tabId, snapshot?.generation ?? 0]) : undefined
  }
  return undefined
}

function clearActionFailures(session: ReturnType<BrowserToolSessionRegistry["getOrCreate"]>): void {
  session.blockedActionLoop = undefined
  session.lastNonRetryableActionFailure = undefined
}

function toolResult(toolUseId: string, value: unknown, isError = false, repeatState?: unknown): ToolResult {
  const result: ToolResult = {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: JSON.stringify(value),
    ...(isError ? { is_error: true } : {}),
  }
  return repeatState === undefined ? result : withRepeatGuardState(result, repeatState)
}

function screenshotToolResult(toolUseId: string, sessionId: string, result: Record<string, unknown>): ToolResult {
  const image = asRecord(result.image)
  const data = stringValue(image.data)
  const mediaType = stringValue(image.media_type)
  if (!data || !mediaType) throw new Error("browser_internal_error")
  const screenshotId = `browser-screenshot:${randomUUID()}`
  return withRepeatGuardState({
    type: "tool_result",
    tool_use_id: toolUseId,
    content: [
      { type: "text", text: JSON.stringify({ ok: true, operation_id: toolUseId, session_id: sessionId, active_tab_id: result.active_tab_id, full_page: result.full_page, annotated: result.annotated === true, snapshot_id: result.snapshot_id, annotated_refs: result.annotated_refs, screenshot_id: screenshotId }) },
      { type: "image", source: { type: "base64", media_type: mediaType, data }, _meta: { persist: false, screenshotId } },
    ],
  }, { ok: true, tool: "screenshot", active_tab_id: result.active_tab_id, full_page: result.full_page })
}

function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined }
function finiteNumber(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0 }
function boundedTimeout(value: unknown): number { return typeof value === "number" && Number.isInteger(value) ? Math.max(100, Math.min(BROWSER_HANDLER_WAIT_CAP_MS, value)) : 10_000 }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }

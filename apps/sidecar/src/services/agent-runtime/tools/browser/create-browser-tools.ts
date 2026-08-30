/**
 * 浏览器工具族 —— 把 agent 工具面映射到 ZCode 46 命令协议(sidecar IAB 后端)。
 *
 * 门面语义对照 .zcode/analysis/zcode-browser-panel-architecture.md §14/§18:
 * tab 连续性(list→验证→get/activate,禁止按下标选 tab)、观察经济学
 * (domSnapshot 为默认观察;截图仅视觉必要时)、claim/user.openTabs 归属链、
 * finalize/markDeliverable/markHandoff、visibility capability、recording。
 * 46 命令全量经 browserCommandSchema zod 校验后下发,协议形状单源在 shared。
 */
import { randomUUID } from "node:crypto";

import type { ToolDefinition, ToolInputSchema, ToolResult } from "@lume/agent-sdk";
import {
  browserCommandSchema,
  type BrowserCommand,
  type BrowserCommandContext,
  type BrowserCommandResult,
} from "@lume/shared";

import {
  getActiveIabBrowserBackend,
  isIabBrowserTransportAvailable,
  type BrowserIabBackend,
} from "../../../../services/browser/iab-backend";
import { isBrowserAgentToolsEnabled } from "./browser-availability";

export const BROWSER_MCP_SERVER_ID = "browser";
const WRAPPER_PREFIX = `mcp__${BROWSER_MCP_SERVER_ID}__`;

export const BROWSER_TOOL_NAMES = [
  "tabs_list",
  "user_open_tabs",
  "claim_tab",
  "tabs_new",
  "tabs_activate",
  "tabs_close",
  "tabs_finalize",
  "navigate",
  "tab_action",
  "viewport",
  "snapshot",
  "screenshot",
  "interact",
  "playwright",
  "cua",
  "dom_cua",
  "dialog",
  "recording",
  "visibility",
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

const READ_ONLY_TOOLS = new Set<BrowserToolName>(["tabs_list", "user_open_tabs", "snapshot", "screenshot"]);

const OPTIONAL_TAB_ID = { type: "string", description: "目标 tab id;缺省为当前作用域活动 tab。" } as const;

function schema(properties: Record<string, unknown>, required: string[] = []): ToolInputSchema {
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

/* ── 描述(SKILL/control-browser 同源语义的精简版) ──────────────────── */

function describeTool(name: BrowserToolName): string {
  switch (name) {
    case "tabs_list":
      return "List all browser tabs controlled by this session (id/url/title/viewport/active/lifecycle). Run this in a dedicated step before your first action on any tab: match the intended tab by verified id/url/title — never by array position or a remembered id."
    case "user_open_tabs":
      return "List the user's own open browser tabs (id/url/title). If no controlled tab matches the target page, inspect this list and claim the matching tab instead of creating a new one."
    case "claim_tab":
      return "Claim a user tab (by id from user_open_tabs) into this session's control. After claiming, activate it before the first read or action."
    case "tabs_new":
      return "Create a new controlled browser tab, optionally navigating it to a URL in the same call. The new tab becomes the active tab and opens the browser pane."
    case "tabs_activate":
      return "Activate a controlled tab by verified id (from tabs_list), making it the target of subsequent tabId-less calls."
    case "tabs_close":
      return "Close a controlled tab. Do not close research/source tabs merely because the turn is ending."
    case "tabs_finalize":
      return "Mark listed tabs as deliverable (user-facing result) or handoff (for another task). Tabs omitted from keep stay open — finalizing never closes them."
    case "navigate":
      return "Navigate a tab to a URL (http/https/about:blank only; file:/data:/javascript: are rejected). After goto, explicitly waitForLoadState(domcontentloaded) before the first observation. Never navigate to the same URL again to refresh; use reload."
    case "tab_action":
      return "Go back, forward, or reload the tab's page."
    case "viewport":
      return "Set or reset the tab viewport size (CSS pixels, 320..3840 x 320..2160) for responsive-layout testing."
    case "snapshot":
      return "Take an interactive-element snapshot of the page: refs (e*) with tag/role/name/text/rect plus a compact DOM tree. This is the default way to read a page and the only valid source of refs and selectors for later actions."
    case "screenshot":
      return "Capture a PNG screenshot of the tab (viewport or full page). Use only when vision matters: layout/styling confirmation, the user asked for screenshots, or the target is not in the snapshot (canvas/custom widgets) and you need coordinates."
    case "interact":
      return "Interact with a snapshot element by ref, or by page coordinates when ref-less: click, fill, type, press, scroll, hover, select, check, drag. Use refs from the newest snapshot only; an unchanged URL does not prove a click failed — observe the expected effect."
    case "playwright":
      return "Playwright facade over the tab: domSnapshot (AI/ARIA tree), locator actions built ONLY from snapshot facts (css/text/xpath/role selector; click/fill/press/selectOption/check/count/textContent/getAttribute/isVisible/waitFor/evaluate...), page evaluate, waitForURL/waitForLoadState, elementInfo/elementScreenshot by coordinates, downloadPath. Routine locator/evaluate budget is 3000ms; after a locator timeout take a fresh snapshot and rebuild — never retry the same locator. File uploads are unsupported."
    case "cua":
      return "Coordinate-level input via CDP (visual path): keypress, anchored scroll, full-path drag. Pair with a screenshot to aim. Use for canvas/custom-drawn/non-DOM widgets the snapshot cannot see."
    case "dom_cua":
      return "Scroll via DOM node path (nodeId = snapshot ref; defaults to viewport center). For clicks/type prefer interact or playwright locators built from snapshot facts."
    case "dialog":
      return "Read (get) or resolve (handle: accept/reject, optional promptText) the tab's blocking JavaScript dialog. While a dialog is open other actions fail — always get then handle."
    case "recording":
      return "Record the tab to WebM: start (data-only action DSL: wait/click/type/hover/move/scroll/scrollTo/wheel/drag/waitFor; max 90s, one recording per tab), then poll status and pass a workspace-relative .webm outputPath only when polling for the final artifact; or cancel."
    case "visibility":
      return "Read or set browser pane visibility. The browser works in the background by default — only hide/show when the task explicitly needs it; do not steal user focus."
  }
}

/* ── schema ────────────────────────────────────────────────────────── */

function toolSchema(name: BrowserToolName): ToolInputSchema {
  switch (name) {
    case "tabs_list":
      return schema({});
    case "user_open_tabs":
      return schema({});
    case "claim_tab":
      return schema({ tabId: { type: "string", description: "user_open_tabs 返回的用户 tab id。" } }, ["tabId"]);
    case "tabs_new":
      return schema({ url: { type: "string", description: "创建后立即导航到的 URL(http/https/about:blank)。" } });
    case "tabs_activate":
      return schema({ tabId: { type: "string", description: "tabs_list 返回的受控 tab id。" } }, ["tabId"]);
    case "tabs_close":
      return schema({ tabId: OPTIONAL_TAB_ID });
    case "tabs_finalize":
      return schema({
        keep: {
          type: "array", minItems: 1, description: "要保留并标记的 tab 列表。",
          items: {
            type: "object", properties: {
              tabId: { type: "string" },
              status: { type: "string", enum: ["deliverable", "handoff"] },
            }, required: ["tabId", "status"], additionalProperties: false,
          },
        },
      }, ["keep"]);
    case "navigate":
      return schema({ url: { type: "string", description: "目标 URL(仅 http/https/about:blank)。" }, tabId: OPTIONAL_TAB_ID }, ["url"]);
    case "tab_action":
      return schema({ action: { type: "string", enum: ["back", "forward", "reload"] }, tabId: OPTIONAL_TAB_ID }, ["action"]);
    case "viewport":
      return schema({
        action: { type: "string", enum: ["set", "reset"] },
        width: { type: "integer", minimum: 320, maximum: 3840 },
        height: { type: "integer", minimum: 320, maximum: 2160 },
        tabId: OPTIONAL_TAB_ID,
      }, ["action"]);
    case "snapshot":
      return schema({
        tabId: OPTIONAL_TAB_ID,
        maxElements: { type: "integer", minimum: 1, description: "可交互元素上限,缺省 200。" },
        includeHidden: { type: "boolean", description: "包含隐藏元素,缺省 false。" },
      });
    case "screenshot":
      return schema({
        tabId: OPTIONAL_TAB_ID,
        fullPage: { type: "boolean", description: "整页截图,缺省仅视口。" },
        clip: {
          type: "object", properties: {
            x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" },
          }, required: ["x", "y", "width", "height"], additionalProperties: false,
        },
      });
    case "interact":
      return schema({
        action: { type: "string", enum: ["click", "fill", "type", "press", "scroll", "hover", "select", "check", "drag"] },
        tabId: OPTIONAL_TAB_ID,
        ref: { type: "string", description: "最新快照的元素 ref(e*)。" },
        x: { type: "number" }, y: { type: "number" },
        text: { type: "string", description: "fill/type 文本。" },
        key: { type: "string", description: "press 键名,如 Enter / Control+a。" },
        values: { type: "array", items: { type: "string" }, description: "select 目标值。" },
        checked: { type: "boolean", description: "check 目标态,缺省 true。" },
        button: { type: "string", enum: ["left", "middle", "right"] },
        doubleClick: { type: "boolean" },
        modifiers: { type: "array", items: { type: "string", enum: ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"] } },
        fromRef: { type: "string" }, toRef: { type: "string" },
        from: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false },
        to: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false },
      }, ["action"]);
    case "playwright":
      return schema({
        tabId: OPTIONAL_TAB_ID,
        action: { description: "playwright 动作:domSnapshot / elementInfo / elementScreenshot / evaluate / waitForURL / waitForLoadState / locator / downloadPath / waitForEvent / fileChooserSetFiles。" },
      }, ["action"]);
    case "cua":
      return schema({
        action: { type: "string", enum: ["keypress", "scroll", "drag"] },
        tabId: OPTIONAL_TAB_ID,
        keys: { type: "array", items: { type: "string" }, minItems: 1, description: "keypress 键序列。" },
        x: { type: "number" }, y: { type: "number" },
        scrollX: { type: "number" }, scrollY: { type: "number" },
        path: { type: "array", items: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false }, minItems: 2 },
        modifiers: { type: "array", items: { type: "string", enum: ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"] } },
      }, ["action"]);
    case "dom_cua":
      return schema({
        tabId: OPTIONAL_TAB_ID,
        nodeId: { type: "string", description: "快照 ref;缺省滚动视口中心。" },
        scrollX: { type: "number" }, scrollY: { type: "number" },
      }, ["scrollX", "scrollY"]);
    case "dialog":
      return schema({
        action: { type: "string", enum: ["get", "handle"] },
        tabId: OPTIONAL_TAB_ID,
        accept: { type: "boolean", description: "handle:接受或拒绝对话框。" },
        promptText: { type: "string", description: "handle:prompt 对话框的输入文本。" },
      }, ["action"]);
    case "recording":
      return schema({
        action: { type: "string", enum: ["start", "status", "cancel"] },
        tabId: OPTIONAL_TAB_ID,
        recordingId: { type: "string", description: "status/cancel 必填(start 返回)。" },
        options: { type: "object", description: "start 可选项:{viewport,fps,maxDurationMs<=90000,settleMs,showCursor,actions[]}。" },
      }, ["action"]);
    case "visibility":
      return schema({ visible: { type: "boolean", description: "缺省读取当前可见性;传入布尔则设置。" } });
  }
}

/* ── 组装:工具输入 → 协议命令 ──────────────────────────────────────── */

/** 协议外的纯工具层输入(非 string/number/boolean/object 的值直接丢弃)。 */
function pick(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (args[key] !== undefined) out[key] = args[key];
  return out;
}

function buildCommand(name: BrowserToolName, args: Record<string, unknown>): BrowserCommand | null {
  const tabId = typeof args.tabId === "string" && args.tabId ? args.tabId : undefined;
  switch (name) {
    case "tabs_list":
      return { method: "list" };
    case "user_open_tabs":
      return { method: "listUserTabs" };
    case "claim_tab":
      return { method: "claimTab", tabId: String(args.tabId) };
    case "tabs_new":
      return { method: "newTab" };
    case "tabs_activate":
      return { method: "activateTab", tabId: String(args.tabId) };
    case "tabs_close":
      return { method: "close", ...(tabId !== undefined ? { tabId } : {}) };
    case "tabs_finalize":
      return { method: "finalizeTabs", keep: args.keep as Array<{ tabId: string; status: "deliverable" | "handoff" }> };
    case "navigate":
      return { method: "navigate", ...(tabId !== undefined ? { tabId } : {}), url: String(args.url) };
    case "tab_action":
      return { method: String(args.action) as "back" | "forward" | "reload", ...(tabId !== undefined ? { tabId } : {}) };
    case "viewport":
      return args.action === "reset"
        ? { method: "browserViewportReset", ...(tabId !== undefined ? { tabId } : {}) }
        : { method: "browserViewportSet", ...(tabId !== undefined ? { tabId } : {}), ...pick(args, ["width", "height"]) } as BrowserCommand;
    case "snapshot":
      return { method: "snapshot", ...(tabId !== undefined ? { tabId } : {}), ...pick(args, ["maxElements", "includeHidden"]) } as BrowserCommand;
    case "screenshot":
      return { method: "screenshot", ...(tabId !== undefined ? { tabId } : {}), ...pick(args, ["fullPage", "clip"]) } as BrowserCommand;
    case "interact": {
      // fill 与 type 同构 {ref?, text};desktop 执行器只路由 type(点击聚焦 +
      // 合成粘贴替换),fill 无路由必返 capability_unsupported —— 工具层直接映射。
      const action = String(args.action);
      return {
        method: action === "fill" ? "type" : action,
        ...(tabId !== undefined ? { tabId } : {}),
        ...interactParams(args),
      } as BrowserCommand;
    }
    case "playwright":
      return { method: "playwright", ...(tabId !== undefined ? { tabId } : {}), action: args.action as Extract<BrowserCommand, { method: "playwright" }>["action"] };
    case "cua": {
      const action = String(args.action);
      const method = action === "keypress" ? "cuaKeypress" : action === "scroll" ? "cuaScroll" : "cuaDrag";
      return { method, ...(tabId !== undefined ? { tabId } : {}), ...cuaParams(action, args) } as BrowserCommand;
    }
    case "dom_cua":
      return { method: "domCuaScroll", ...(tabId !== undefined ? { tabId } : {}), ...pick(args, ["nodeId", "scrollX", "scrollY"]) } as BrowserCommand;
    case "dialog":
      return args.action === "get"
        ? { method: "getDialog", ...(tabId !== undefined ? { tabId } : {}) }
        : { method: "handleDialog", ...(tabId !== undefined ? { tabId } : {}), ...pick(args, ["accept", "promptText"]) } as BrowserCommand;
    case "recording": {
      const action = String(args.action);
      if (action === "start") {
        return {
          method: "recordingStart",
          ...(tabId !== undefined ? { tabId } : {}),
          ...(args.options !== undefined && args.options !== null && typeof args.options === "object" ? { options: args.options } : {}),
        } as BrowserCommand;
      }
      const method = action === "status" ? "recordingStatus" : "recordingCancel";
      return { method, ...(tabId !== undefined ? { tabId } : {}), recordingId: String(args.recordingId) } as BrowserCommand;
    }
    case "visibility":
      return args.visible === undefined
        ? { method: "browserVisibilityGet" }
        : { method: "browserVisibilitySet", visible: Boolean(args.visible) };
  }
}

function interactParams(args: Record<string, unknown>): Record<string, unknown> {
  switch (String(args.action)) {
    case "fill":
    case "type":
      return pick(args, ["ref", "text"]);
    case "press":
      return { ...pick(args, ["ref", "modifiers"]), key: String(args.key) };
    case "select":
      return { ref: String(args.ref), values: args.values as string[] };
    case "check":
      return { ref: String(args.ref), ...(args.checked !== undefined ? { checked: args.checked } : {}) };
    case "drag":
      return {
        ...pick(args, ["fromRef", "toRef", "modifiers"]),
        ...(args.from !== undefined ? { from: args.from } : {}),
        ...(args.to !== undefined ? { to: args.to } : {}),
      };
    default: // click / hover / scroll:ref 或坐标
      return pick(args, ["ref", "x", "y", "button", "doubleClick", "modifiers"]);
  }
}

function cuaParams(action: string, args: Record<string, unknown>): Record<string, unknown> {
  if (action === "keypress") return { keys: args.keys as string[] };
  if (action === "scroll") return pick(args, ["x", "y", "scrollX", "scrollY", "modifiers"]);
  return { ...pick(args, ["modifiers"]), path: args.path as Array<{ x: number; y: number }> };
}

/** 组装后的命令必须过协议 zod 闸:模型可见的输入错误不进传输层。 */
function validateCommand(command: BrowserCommand): string | null {
  const parsed = browserCommandSchema.safeParse(command);
  return parsed.success ? null : `invalid ${command.method} arguments: ${parsed.error.issues[0]?.path.join(".") ?? "(root)"} ${parsed.error.issues[0]?.message ?? ""}`.trim();
}

/* ── 结果塑形 ──────────────────────────────────────────────────────── */

/**
 * 面向模型的公开视图:剥 meta(generation 刻意不可见,§18.3)与 elapsedMs。
 * error 负载(guide §4.3 稳定码 + sideEffect)必须保留——它是模型的重试决策依据。
 * screenshot 命中的 image 载荷转成 image 内容块。
 */
function publicResult(result: BrowserCommandResult): Record<string, unknown> {
  const { meta: _meta, elapsedMs: _elapsedMs, ...fields } = result;
  return fields;
}

function toolResult(toolUseId: string, text: string, isError: boolean, image?: { data: string; mediaType: string }): ToolResult {
  if (image) {
    return {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: [
        { type: "text", text },
        { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
      ],
      ...(isError ? { is_error: true } : {}),
    };
  }
  return { type: "tool_result", tool_use_id: toolUseId, content: text, ...(isError ? { is_error: true } : {}) };
}

function imagePayload(result: BrowserCommandResult): { data: string; mediaType: string } | undefined {
  const image = result["image"];
  if (!image || typeof image !== "object") return undefined;
  const data = (image as { data?: unknown }).data;
  const mediaType = (image as { media_type?: unknown }).media_type;
  if (typeof data !== "string" || !data || typeof mediaType !== "string" || !mediaType) return undefined;
  return { data, mediaType };
}

/* ── 工具族 ────────────────────────────────────────────────────────── */

export interface CreateBrowserToolsInput {
  threadId: string;
  runId?: string;
  workspaceId?: string;
  workspaceSlug?: string;
  /** 测试注入;缺省进程级 IAB 单例。 */
  backend?: Pick<BrowserIabBackend, "descriptor" | "execute">;
}

export function createBrowserTools(input: CreateBrowserToolsInput): ToolDefinition[] {
  const backend = input.backend ?? getActiveIabBrowserBackend();
  const workspaceKey = input.workspaceSlug ?? input.workspaceId ?? input.threadId;

  const buildContext = (): BrowserCommandContext => ({
    requestId: randomUUID(),
    sessionId: input.threadId,
    turnId: input.runId,
    workspaceKey,
    browserId: backend.descriptor.id,
    browserGeneration: backend.descriptor.generation,
    clientMode: "desktop-continuous",
  });

  const executeCommand = async (command: BrowserCommand): Promise<BrowserCommandResult> =>
    backend.execute({ context: buildContext(), command });

  return BROWSER_TOOL_NAMES.map((name) => {
    const readOnly = READ_ONLY_TOOLS.has(name);
    return {
      name: `${WRAPPER_PREFIX}${name}`,
      description: describeTool(name),
      inputSchema: toolSchema(name),
      isReadOnly: () => readOnly,
      isConcurrencySafe: () => false,
      isEnabled: () => isBrowserAgentToolsEnabled() && isIabBrowserTransportAvailable(),
      async prompt() { return describeTool(name); },
      runtimeMetadata: {
        source: "mcp",
        category: readOnly ? "read" : "execute",
        capability: "mcp",
        riskLevel: readOnly ? "low" : "medium",
        sideEffects: readOnly ? "none" : "desktop",
        allowedInPlanMode: readOnly,
        isReadOnly: readOnly,
        isConcurrencySafe: false,
        requiresApprovalByDefault: false,
        executionPolicy: { allowBackground: false },
        mcpServerId: BROWSER_MCP_SERVER_ID,
        builtin: true,
      },
      async call(rawArgs, context) {
        const toolUseId = context.toolUseId || randomUUID();
        const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
        const command = buildCommand(name, args);
        if (!command) return toolResult(toolUseId, JSON.stringify({ ok: false, code: "execution_error", message: `unsupported tool: ${name}` }), true);
        const invalid = validateCommand(command);
        if (invalid) return toolResult(toolUseId, JSON.stringify({ ok: false, code: "execution_error", message: invalid }), true);
        let result: BrowserCommandResult;
        try {
          result = await executeCommand(command);
        } catch (error) {
          // 后端不抛(全部折进结果信封);此处兜住注入实现的意外异常。
          result = { ok: false, error: { code: "execution_error", message: error instanceof Error ? error.message : String(error) } };
        }
        // tabs_new 附带 url:newTab 成功后在同一工具调用内导航(门面 open 语义的简化)。
        if (name === "tabs_new" && result.ok && typeof args.url === "string") {
          const tabId = newTabId(result);
          if (tabId) {
            const navigated = await executeCommand({ method: "navigate", tabId, url: args.url });
            return toolResult(toolUseId, JSON.stringify({ ...publicResult(navigated), tabId }), !navigated.ok);
          }
        }
        const image = name === "screenshot" && result.ok ? imagePayload(result) : undefined;
        const text = JSON.stringify(image ? { ...publicResult(result), image: { media_type: image.mediaType, bytes: Math.round(image.data.length * 0.75) } } : publicResult(result));
        return toolResult(toolUseId, text, !result.ok, image);
      },
    } satisfies ToolDefinition;
  });
}

function newTabId(result: BrowserCommandResult): string | null {
  const fromMeta = result.meta?.tabId;
  if (fromMeta) return fromMeta;
  const tab = result["tab"];
  if (tab && typeof tab === "object") {
    const tabId = (tab as { tabId?: unknown }).tabId;
    if (typeof tabId === "string") return tabId;
  }
  const direct = result["tabId"];
  return typeof direct === "string" ? direct : null;
}

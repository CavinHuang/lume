import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

interface ActRequest {
  kind: "click" | "type" | "press" | "hover" | "select" | "drag" | "wait" | "evaluate" | "resize" | "fill" | "close";
  selector?: string;
  text?: string;
  key?: string;
  values?: string[];
  startSelector?: string;
  endSelector?: string;
  width?: number;
  height?: number;
  timeMs?: number;
  fn?: string;
  fields?: Array<{ selector: string; value: string }>;
}

const ACTIONS = ["status", "start", "stop", "navigate", "snapshot", "screenshot", "click", "type", "press", "wait", "tabs", "open", "focus", "close", "console", "hover", "select", "drag", "evaluate", "pdf", "upload", "dialog", "resize", "fill", "profiles", "act", "extension_info", "extension_install", "relay_status"] as const;

function toResult<T>(details: T): AgentToolResult<T> {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details
  };
}

const BrowserToolSchema = Type.Object({
  action: Type.Union(ACTIONS.map(a => Type.Literal(a))),
  mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("playwright"), Type.Literal("relay")])),
  url: Type.Optional(Type.String({ description: "URL for navigate/open action" })),
  selector: Type.Optional(Type.String({ description: "CSS selector" })),
  text: Type.Optional(Type.String({ description: "Text for type action" })),
  key: Type.Optional(Type.String({ description: "Key for press action" })),
  ms: Type.Optional(Type.Number({ description: "Milliseconds for wait" })),
  maxChars: Type.Optional(Type.Number({ description: "Max chars for snapshot" })),
  targetId: Type.Optional(Type.String({ description: "Tab targetId" })),
  level: Type.Optional(Type.String({ description: "Console log level" })),
  values: Type.Optional(Type.Array(Type.String(), { description: "Values for select" })),
  endSelector: Type.Optional(Type.String({ description: "End selector for drag" })),
  fn: Type.Optional(Type.String({ description: "JS for evaluate" })),
  fullPage: Type.Optional(Type.Boolean({ description: "Full page screenshot" })),
  element: Type.Optional(Type.String({ description: "Element for screenshot" })),
  interactive: Type.Optional(Type.Boolean({ description: "Interactive elements only" })),
  paths: Type.Optional(Type.Array(Type.String(), { description: "File paths for upload" })),
  accept: Type.Optional(Type.Boolean({ description: "Accept dialog" })),
  promptText: Type.Optional(Type.String({ description: "Dialog prompt text" })),
  width: Type.Optional(Type.Number({ description: "Viewport width" })),
  height: Type.Optional(Type.Number({ description: "Viewport height" })),
  fields: Type.Optional(Type.Array(Type.Object({ selector: Type.String(), value: Type.String() }), { description: "Fields for fill" })),
  request: Type.Optional(Type.Object({
    kind: Type.String(),
    selector: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
    key: Type.Optional(Type.String()),
    values: Type.Optional(Type.Array(Type.String())),
    startSelector: Type.Optional(Type.String()),
    endSelector: Type.Optional(Type.String()),
    width: Type.Optional(Type.Number()),
    height: Type.Optional(Type.Number()),
    timeMs: Type.Optional(Type.Number()),
    fn: Type.Optional(Type.String()),
    fields: Type.Optional(Type.Array(Type.Object({ selector: Type.String(), value: Type.String() })))
  }, { description: "Act request object" }))
});

export function createBrowserTool(): AgentTool {
  return {
    name: "browser",
    label: "Browser",
    description: `Browser automation tool.

Actions: status, start, stop, navigate, snapshot, screenshot, click, type, press, wait, tabs, open, focus, close, console, hover, select, drag, evaluate, pdf, upload, dialog, resize, fill, extension_info, extension_install, relay_status

Examples:
- { "action": "start" } // 默认 auto: 先 relay, 失败再 playwright
- { "action": "start", "mode": "relay" }
- { "action": "extension_info" }
- { "action": "extension_install" }
- { "action": "relay_status" }
- { "action": "navigate", "url": "https://example.com" }
- { "action": "click", "selector": "#btn" }
- { "action": "upload", "selector": "input[type=file]", "paths": ["/tmp/a.png"] }
- { "action": "fill", "fields": [{"selector": "#name", "value": "test"}] }`,
    parameters: BrowserToolSchema,
    async execute(_toolCallId, args) {
      const params = args as Record<string, unknown>;
      const action = params.action as string;
      const browserApi = await import("../../browser/browser-service");

      try {
        switch (action) {
          case "status":
            return toResult(await browserApi.getBrowserStatus());
          case "start": {
            const mode = params.mode === "relay"
              ? "relay"
              : params.mode === "playwright"
                ? "playwright"
                : "auto";
            return toResult(await browserApi.startBrowser(mode));
          }
          case "stop":
            return toResult(await browserApi.stopBrowser());
          case "navigate": {
            const url = params.url as string;
            if (!url) return toResult({ error: "url is required" });
            return toResult(await browserApi.navigateTo(url));
          }
          case "snapshot": {
            const opts = {
              maxChars: typeof params.maxChars === "number" ? params.maxChars : 8000,
              selector: params.selector as string | undefined,
              interactive: params.interactive as boolean | undefined
            };
            return toResult(await browserApi.getSnapshot(opts));
          }
          case "screenshot":
            return toResult(await browserApi.takeScreenshot({
              fullPage: params.fullPage as boolean | undefined,
              element: params.element as string | undefined
            }));
          case "click": {
            const selector = params.selector as string;
            if (!selector) return toResult({ error: "selector is required" });
            return toResult(await browserApi.browserClick(selector));
          }
          case "type": {
            const selector = params.selector as string;
            const text = params.text as string;
            if (!selector || !text) return toResult({ error: "selector and text required" });
            return toResult(await browserApi.browserType(selector, text));
          }
          case "press": {
            const key = params.key as string;
            if (!key) return toResult({ error: "key is required" });
            return toResult(await browserApi.browserPress(key));
          }
          case "wait": {
            const ms = typeof params.ms === "number" ? params.ms : 1000;
            return toResult(await browserApi.browserWait(ms));
          }
          case "tabs":
            return toResult(await browserApi.getTabs());
          case "open":
            return toResult(await browserApi.openTab(params.url as string || "about:blank"));
          case "focus": {
            const targetId = params.targetId as string;
            if (!targetId) return toResult({ error: "targetId is required" });
            return toResult(await browserApi.focusTab(targetId));
          }
          case "close": {
            const targetId = params.targetId as string;
            if (!targetId) return toResult({ error: "targetId is required" });
            return toResult(await browserApi.closeTab(targetId));
          }
          case "console":
            return toResult(await browserApi.getConsoleMessages(params.level as string | undefined));
          case "hover": {
            const selector = params.selector as string;
            if (!selector) return toResult({ error: "selector is required" });
            return toResult(await browserApi.browserHover(selector));
          }
          case "select": {
            const selector = params.selector as string;
            const values = params.values as string[];
            if (!selector || !values) return toResult({ error: "selector and values required" });
            return toResult(await browserApi.browserSelect(selector, values));
          }
          case "drag": {
            const selector = params.selector as string;
            const endSelector = params.endSelector as string;
            if (!selector || !endSelector) return toResult({ error: "selector and endSelector required" });
            return toResult(await browserApi.browserDrag(selector, endSelector));
          }
          case "evaluate": {
            const fn = params.fn as string;
            if (!fn) return toResult({ error: "fn is required" });
            return toResult(await browserApi.browserEvaluate(fn));
          }
          case "pdf":
            return toResult(await browserApi.browserPdf());
          case "upload": {
            const selector = params.selector as string;
            const paths = params.paths as string[];
            if (!selector || !paths) return toResult({ error: "selector and paths required" });
            return toResult(await browserApi.browserUpload(selector, paths));
          }
          case "dialog":
            return toResult(await browserApi.browserDialog(params.accept !== false, params.promptText as string | undefined));
          case "resize": {
            const width = params.width as number;
            const height = params.height as number;
            if (!width || !height) return toResult({ error: "width and height required" });
            return toResult(await browserApi.browserResize(width, height));
          }
          case "fill": {
            const fields = params.fields as Array<{ selector: string; value: string }>;
            if (!fields) return toResult({ error: "fields required" });
            return toResult(await browserApi.browserFill(fields));
          }
          case "profiles":
            return toResult(await browserApi.getProfiles());
          case "extension_info":
            return toResult(await browserApi.getBrowserExtensionInfo());
          case "extension_install":
            return toResult(await browserApi.installBrowserExtension());
          case "relay_status":
            return toResult(await browserApi.getBrowserRelayStatus());
          case "act": {
            const request = params.request as ActRequest;
            if (!request) return toResult({ error: "request required" });
            return toResult(await browserApi.browserAct(request));
          }
          default:
            return toResult({ error: `Unknown action: ${action}` });
        }
      } catch (err) {
        return toResult({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  };
}

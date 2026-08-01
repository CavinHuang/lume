import type { BrowserBackendType } from "./types/browser-runtime";

export type BrowserApiPolicyCategory =
  | "none" | "clipboard" | "history" | "upload" | "download" | "credentials" | "cdp";

export interface BrowserApiRegistration {
  api: string;
  runtimeMethod: string;
  backends: readonly BrowserBackendType[];
  mutates: boolean;
  policy: BrowserApiPolicyCategory;
  capability?: string;
  description: string;
}

/**
 * The single advertised BrowserClient surface. A backend may advertise an API
 * only when this entry exists and its concrete handler is currently available.
 */
export const BROWSER_API_REGISTRY = [
  api("Browser.nameSession", "nameSession", ["iab"], true, "none", "Name the current browser session."),
  api("BrowserUser.history", "history:list", ["iab", "extension"], false, "history", "Read approved browser history."),
  api("Tabs.content", "tabs:content", ["iab"], false, "none", "Read bounded content from background tabs."),
  api("Tabs.finalize", "finalize", ["iab", "extension"], true, "none", "Finalize tabs for handoff or delivery."),
  api("Tab.content", "content", ["iab", "extension"], false, "none", "Read bounded tab content."),
  api("Tab.markDeliverable", "markDeliverable", ["iab", "extension"], true, "none", "Mark a tab as a deliverable."),
  api("Tab.markHandoff", "markHandoff", ["iab", "extension"], true, "none", "Mark a tab for user handoff."),
  api("Tab.browserAuth", "browserAuth:request", ["iab", "extension"], true, "credentials", "Collect and submit credentials through backend-owned secure UI.", "browserAuth"),
  api("Tab.clipboard", "clipboard", ["iab"], false, "clipboard", "Access the session clipboard facade."),
  api("TabClipboardAPI.read", "clipboard:read", ["iab"], false, "clipboard", "Read approved clipboard data."),
  api("TabClipboardAPI.readText", "clipboard:readText", ["iab"], false, "clipboard", "Read approved clipboard text."),
  api("TabClipboardAPI.write", "clipboard:write", ["iab"], true, "clipboard", "Write approved clipboard data."),
  api("TabClipboardAPI.writeText", "clipboard:writeText", ["iab"], true, "clipboard", "Write approved clipboard text."),
  api("CUAAPI.downloadMedia", "downloadMedia", ["iab", "extension"], true, "download", "Download media under task quotas."),
  api("DomCUAAPI.click", "dom:click", ["iab"], true, "none", "Click a current visible DOM node."),
  api("DomCUAAPI.double_click", "dom:doubleClick", ["iab"], true, "none", "Double-click a current visible DOM node."),
  api("DomCUAAPI.downloadMedia", "downloadMedia", ["iab", "extension"], true, "download", "Download media from a visible DOM node."),
  api("DomCUAAPI.get_visible_dom", "dom:visible", ["iab"], false, "none", "Read the bounded visible DOM."),
  api("DomCUAAPI.keypress", "dom:keypress", ["iab"], true, "none", "Send a key press to a visible DOM node."),
  api("DomCUAAPI.scroll", "dom:scroll", ["iab"], true, "none", "Scroll a visible DOM node."),
  api("DomCUAAPI.type", "dom:type", ["iab"], true, "none", "Type into a visible DOM node."),
  api("PlaywrightAPI.elementInfo", "elementInfo", ["iab"], false, "none", "Inspect one strict locator target."),
  api("PlaywrightAPI.elementScreenshot", "elementScreenshot", ["iab"], false, "none", "Capture one strict locator target."),
  api("PlaywrightAPI.evaluate", "evaluate:readonly", ["iab", "extension"], false, "none", "Evaluate read-only JavaScript in an isolated context."),
  api("PlaywrightAPI.frameLocator", "frameLocator", ["iab"], false, "none", "Resolve a strict frame locator."),
  api("PlaywrightAPI.waitForEvent", "wait:event", ["iab", "extension"], false, "none", "Wait for a bounded browser event."),
  api("PlaywrightDownload.path", "download:path", ["iab"], false, "download", "Resolve an authorized browser download reference."),
  api("PlaywrightFileChooser.setFiles", "filechooser:setFiles", ["iab", "extension"], true, "upload", "Set authorized FileRefs on a file chooser."),
  api("PlaywrightLocator.evaluate", "locator:evaluate", ["iab", "extension"], false, "none", "Evaluate a read-only expression for a strict locator."),
  api("PlaywrightLocator.downloadMedia", "downloadMedia", ["iab", "extension"], true, "download", "Download media from a strict locator."),
  api("TabDevAPI.logs", "dev:logs", ["iab"], false, "none", "Read bounded console logs."),
] as const satisfies readonly BrowserApiRegistration[];

export function browserApiSupportForBackend(
  backend: BrowserBackendType,
  registeredRuntimeMethods: ReadonlySet<string>,
  declaredSupport?: Readonly<Record<string, unknown>>,
): Record<string, boolean> {
  return Object.fromEntries(BROWSER_API_REGISTRY.map((entry) => [
    entry.api,
    entry.backends.includes(backend)
      && registeredRuntimeMethods.has(entry.runtimeMethod)
      && (declaredSupport === undefined || declaredSupport[entry.api] === true),
  ]));
}

export function browserMutatingRuntimeMethods(): Set<string> {
  return new Set(BROWSER_API_REGISTRY.filter((entry) => entry.mutates).map((entry) => entry.runtimeMethod));
}

export function browserApiPolicyForRuntimeMethod(runtimeMethod: string): BrowserApiPolicyCategory {
  return BROWSER_API_REGISTRY.find((entry) => entry.runtimeMethod === runtimeMethod && entry.policy !== "none")?.policy ?? "none";
}

function api(
  apiName: string,
  runtimeMethod: string,
  backends: readonly BrowserBackendType[],
  mutates: boolean,
  policy: BrowserApiPolicyCategory,
  description: string,
  capability?: string,
): BrowserApiRegistration {
  return { api: apiName, runtimeMethod, backends, mutates, policy, description, ...(capability ? { capability } : {}) };
}

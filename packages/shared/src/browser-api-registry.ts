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
  api("Browser.nameSession", "nameSession", ["iab", "extension"], true, "none", "Name the current browser session."),
  api("BrowserUser.claimTab", "claim", ["iab", "extension"], true, "none", "Claim an exact user tab snapshot for the current turn."),
  api("BrowserUser.history", "history:list", ["iab", "extension"], false, "history", "Read approved browser history."),
  api("Tabs.content", "tabs:content", ["iab"], false, "none", "Read bounded content from background tabs."),
  api("Tabs.finalize", "finalize", ["iab", "extension"], true, "none", "Finalize tabs for handoff or delivery."),
  api("Tab.content", "content:export", ["iab", "extension"], false, "none", "Access tab content export."),
  api("ContentAPI.export", "content:export", ["iab", "extension"], true, "download", "Export bounded tab content to an authorized task file."),
  api("ContentAPI.exportGsuite", "content:exportGsuite", ["extension"], true, "download", "Export Google Workspace content through the browser backend."),
  api("Tab.markDeliverable", "mark", ["iab", "extension"], true, "none", "Mark a tab as a deliverable."),
  api("Tab.markHandoff", "mark", ["iab", "extension"], true, "none", "Mark a tab for user handoff."),
  api("Tab.browserAuth", "browserAuth:request", ["iab", "extension"], true, "credentials", "Collect and submit credentials through backend-owned secure UI.", "browserAuth"),
  api("BrowserSecrets.list", "secrets:list", ["iab"], false, "none", "List saved credential metadata for the current origin."),
  api("BrowserSecrets.fill", "secretFill", ["iab"], true, "credentials", "Fill a saved secret without exposing its value to the agent."),
  api("Tab.clipboard", "clipboard", ["iab", "extension"], false, "clipboard", "Access the session clipboard facade."),
  api("TabClipboardAPI.read", "clipboard:read", ["iab", "extension"], false, "clipboard", "Read approved clipboard data."),
  api("TabClipboardAPI.readText", "clipboard:readText", ["iab", "extension"], false, "clipboard", "Read approved clipboard text."),
  api("TabClipboardAPI.write", "clipboard:write", ["iab", "extension"], true, "clipboard", "Write approved clipboard data."),
  api("TabClipboardAPI.writeText", "clipboard:writeText", ["iab", "extension"], true, "clipboard", "Write approved clipboard text."),
  api("CUAAPI.downloadMedia", "downloadMedia", ["iab", "extension"], true, "download", "Download media under task quotas."),
  api("DomCUAAPI.click", "dom:click", ["iab", "extension"], true, "none", "Click a current visible DOM node."),
  api("DomCUAAPI.double_click", "dom:doubleClick", ["iab", "extension"], true, "none", "Double-click a current visible DOM node."),
  api("DomCUAAPI.downloadMedia", "downloadMedia", ["iab", "extension"], true, "download", "Download media from a visible DOM node."),
  api("DomCUAAPI.get_visible_dom", "dom:visible", ["iab", "extension"], false, "none", "Read the bounded visible DOM."),
  api("DomCUAAPI.keypress", "dom:keypress", ["iab", "extension"], true, "none", "Send a key press to a visible DOM node."),
  api("DomCUAAPI.scroll", "dom:scroll", ["iab", "extension"], true, "none", "Scroll a visible DOM node."),
  api("DomCUAAPI.type", "dom:type", ["iab", "extension"], true, "none", "Type into a visible DOM node."),
  api("PlaywrightAPI.elementInfo", "elementInfo", ["iab", "extension"], false, "none", "Inspect one strict locator target."),
  api("PlaywrightAPI.elementScreenshot", "elementScreenshot", ["iab", "extension"], false, "none", "Capture one strict locator target."),
  api("PlaywrightAPI.evaluate", "evaluate:readonly", ["iab", "extension"], false, "none", "Evaluate read-only JavaScript in an isolated context."),
  api("PlaywrightAPI.frameLocator", "frameLocator", ["iab", "extension"], false, "none", "Resolve a strict frame locator."),
  api("PlaywrightAPI.waitForEvent", "wait:event", ["iab", "extension"], false, "none", "Wait for a bounded browser event."),
  api("PlaywrightDownload.path", "download:path", ["iab", "extension"], false, "none", "Resolve an authorized browser download reference."),
  api("PlaywrightFileChooser.setFiles", "filechooser:setFiles", ["iab", "extension"], true, "upload", "Set authorized FileRefs on a file chooser."),
  api("PlaywrightLocator.evaluate", "locator:evaluate", ["iab", "extension"], false, "none", "Evaluate a read-only expression for a strict locator."),
  api("PlaywrightLocator.downloadMedia", "downloadMedia", ["iab", "extension"], true, "download", "Download media from a strict locator."),
  api("TabDevAPI.logs", "dev:logs", ["iab", "extension"], false, "none", "Read bounded console logs."),
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

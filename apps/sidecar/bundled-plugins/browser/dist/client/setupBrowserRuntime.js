import { BrowserRegistry, refreshBrowserRegistry, } from "./BrowserClient.js";
import { Documentation } from "./documentation.js";
const BROWSER_RUNTIME = Symbol.for("lume.browser.runtime");
export async function setupBrowserRuntime(options) {
    const globals = options.globals ?? globalThis;
    const symbolGlobals = globals;
    const existing = symbolGlobals[BROWSER_RUNTIME];
    if (isBrowserRuntime(existing))
        return existing;
    const browsers = options.context
        ? new BrowserRegistry(options.transport, options.context, options.readDocument)
        : new BrowserRegistry(options.transport, options.readDocument);
    const agent = {
        browsers,
        documentation: new Documentation(options.readDocument),
    };
    const runtime = {
        agent,
        refreshBackends: () => refreshBrowserRegistry(browsers),
    };
    symbolGlobals[BROWSER_RUNTIME] = runtime;
    globals.agent = agent;
    return runtime;
}
function isBrowserRuntime(value) {
    if (!value || typeof value !== "object")
        return false;
    const runtime = value;
    return !!runtime.agent && typeof runtime.refreshBackends === "function";
}

import { readFile } from "node:fs/promises";
import { JsonRpcTransport, setupBrowserRuntime } from "../dist/browser-client.js";

function browserResponseError(error) {
  const code = typeof error?.code === "string"
    ? error.code
    : error instanceof Error && error.message
      ? error.message
      : "browser_internal_error";
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}

function unwrapBrowserResult(method, result) {
  if (method === "create_tab" || method === "get_tab" || method === "browser_user_claim_tab") {
    return { ...result, tabId: result?.tabId ?? result?.id };
  }
  if (method === "selected_tab") {
    return { ...result, tabId: result?.tabId ?? result?.id };
  }
  if (method === "list_tabs" || method === "get_session_tabs" || method === "resume_handoff_tabs") {
    const tabs = Array.isArray(result) ? result : result?.tabs;
    return (tabs ?? []).map((tab) => ({ ...tab, tabId: tab?.tabId ?? tab?.id }));
  }
  if (method === "tab_title") return result?.title;
  if (method === "tab_url") return result?.url;
  if (method === "playwright_dom_snapshot") return result?.dom_snapshot;
  if (method === "playwright_locator_count") return result?.count;
  if (method === "playwright_locator_all_text_contents" || method === "playwright_locator_read_all") return result?.values;
  if ([
    "playwright_locator_get_attribute",
    "playwright_locator_inner_text",
    "playwright_locator_text_content",
    "playwright_locator_input_value",
    "playwright_locator_is_visible",
    "playwright_locator_is_enabled",
    "playwright_locator_is_checked",
  ].includes(method)) return result?.value;
  return result;
}

export async function setupLumeBrowserRuntime({ globals = globalThis } = {}) {
  const browser = globalThis.nodeRepl?.browser;
  if (typeof browser?.request !== "function") {
    throw new Error("Lume Browser trusted bridge is unavailable");
  }

  const transport = new JsonRpcTransport(async ({ id, method, params }) => {
    try {
      const result = await browser.request(method, params ?? {});
      return { jsonrpc: "2.0", id, result: unwrapBrowserResult(method, result) };
    } catch (error) {
      return { jsonrpc: "2.0", id, error: browserResponseError(error) };
    }
  });
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const runtime = await setupBrowserRuntime({
        globals,
        transport,
        readDocument(name) {
          return readFile(new URL(`../docs/${name}.md`, import.meta.url), "utf8");
        },
      });
      await runtime.refreshBackends();
      return runtime;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

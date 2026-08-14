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

function createBrokerProtocolAdapter() {
  const dialogIdsByTab = new Map();
  const downloadTabs = new Map();

  return {
    prepareRequest(method, params) {
      if (method === "tab_js_dialog_handle") {
        const tabId = params?.tabId;
        return {
          ...params,
          action: params?.accept === false ? "dismiss" : "accept",
          dialogId: params?.dialogId ?? (typeof tabId === "string" ? dialogIdsByTab.get(tabId) : undefined),
        };
      }
      if (method === "playwright_download_path") {
        return { ...params, tabId: params?.tabId ?? downloadTabs.get(params?.downloadId) };
      }
      if (method === "tab_browser_auth_request" && params?.options && typeof params.options === "object") {
        return {
          ...params,
          options: {
            ...params.options,
            options: Array.isArray(params.options.options)
              ? params.options.options.map((option) => ({
                  ...option,
                  selector: option?.selector?.ast ?? option?.selector,
                }))
              : params.options.options,
          },
        };
      }
      return params;
    },
    unwrapResult(method, result, params) {
      if (method === "tab_js_dialog_get") {
        const dialog = result?.dialog ?? result ?? null;
        if (typeof params?.tabId === "string") {
          if (typeof dialog?.id === "string") dialogIdsByTab.set(params.tabId, dialog.id);
          else dialogIdsByTab.delete(params.tabId);
        }
        return dialog;
      }
      if (method === "tab_js_dialog_handle" && typeof params?.tabId === "string") {
        dialogIdsByTab.delete(params.tabId);
      }
      if (method === "playwright_wait_for_download") {
        const downloadId = result?.downloadId ?? result?.download_id;
        if (typeof downloadId === "string" && typeof params?.tabId === "string") downloadTabs.set(downloadId, params.tabId);
      }
      return unwrapBrowserResult(method, result);
    },
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
  if (method === "tab_screenshot") {
    return { dataBase64: typeof result === "string" ? result : result?.dataBase64 ?? result?.data };
  }
  if (method === "browser_user_history") {
    const entries = Array.isArray(result) ? result : result?.items;
    return (entries ?? []).map((entry) => ({
      ...entry,
      lastVisitTime: entry?.lastVisitTime ?? entry?.dateVisited,
    }));
  }
  if (method === "browser_visibility_get") return typeof result === "boolean" ? result : result?.visible;
  if (method === "tabs_content") return Array.isArray(result) ? result : result?.results;
  if (method === "playwright_wait_for_download") {
    return { ...result, downloadId: result?.downloadId ?? result?.download_id };
  }
  if (method === "playwright_wait_for_file_chooser") {
    return {
      ...result,
      chooserId: result?.chooserId ?? result?.file_chooser_id,
      multiple: result?.multiple ?? result?.is_multiple,
    };
  }
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

async function emitBrowserImage(nodeRepl, method, result) {
  if (method !== "tab_screenshot" && method !== "playwright_element_screenshot") return;
  const data = typeof result === "string" ? result : result?.dataBase64 ?? result?.data;
  if (typeof data !== "string" || data.length === 0) return;
  try {
    const bytes = new Uint8Array(Buffer.from(data, "base64"));
    await nodeRepl.emitImage(bytes, data.startsWith("/9j/") ? "image/jpeg" : "image/png");
  } catch {
    // Returning screenshot bytes remains useful even when image emission is unavailable.
  }
}

export async function setupLumeBrowserRuntime({ globals = globalThis } = {}) {
  const nodeRepl = globalThis.nodeRepl;
  const browser = nodeRepl?.browser;
  if (typeof browser?.request !== "function") {
    throw new Error("Lume Browser trusted bridge is unavailable");
  }

  const adapter = createBrokerProtocolAdapter();
  const transport = new JsonRpcTransport(async ({ id, method, params }) => {
    try {
      const requestParams = adapter.prepareRequest(method, params ?? {});
      const result = await browser.request(method, requestParams);
      const adapted = adapter.unwrapResult(method, result, requestParams);
      await emitBrowserImage(nodeRepl, method, adapted);
      return { jsonrpc: "2.0", id, result: adapted };
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

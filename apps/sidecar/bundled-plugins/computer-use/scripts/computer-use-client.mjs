import { readFile } from "node:fs/promises";

const METHODS = Object.freeze([
  "list_windows",
  "get_window",
  "list_apps",
  "launch_app",
  "get_window_state",
  "click",
  "press_key",
  "type_text",
  "scroll",
  "set_value",
  "drag",
  "perform_secondary_action",
  "activate_window",
]);
const DOCUMENTATION = new Set(["guidance", "api", "confirmations"]);

export async function setupComputerUseRuntime({ globals = globalThis } = {}) {
  const computer = globalThis.nodeRepl?.computer;
  if (typeof computer?.request !== "function") {
    throw new Error("Computer Use trusted bridge is unavailable");
  }

  const sky = {};
  for (const method of METHODS) {
    Object.defineProperty(sky, method, {
      enumerable: true,
      value(params = {}) {
        setToolSurface(method, params);
        return computer.request(method, params);
      },
    });
  }
  Object.defineProperty(sky, "documentation", {
    enumerable: true,
    value: readDocumentation,
  });
  Object.freeze(sky);

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const windows = await sky.list_windows();
      if (!Array.isArray(windows)) throw new Error("Computer Use returned an invalid window list");
      globals.sky = sky;
      return sky;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Computer Use connection failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function readDocumentation(name) {
  if (!DOCUMENTATION.has(name)) throw new Error("Unsupported Computer Use documentation");
  return readFile(new URL(`../docs/${name}.md`, import.meta.url), "utf8");
}

function setToolSurface(method, params) {
  const app = params?.window?.app ?? params?.app;
  globalThis.nodeRepl?.setResponseMeta?.({
    "codex/toolSurface": {
      kind: "computerUse",
      method,
      app: typeof app === "string" && app.trim() ? { kind: "appId", appId: app.trim() } : null,
    },
  });
}

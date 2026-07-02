import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

import {
  ALLOWED_RENDERER_EVENT_CHANNELS,
  ALLOWED_RENDERER_INVOKE_COMMANDS,
  createSecureWebPreferences,
  createWindowOpenAction,
  isAllowedMainFrameNavigation,
  resolveAppProtocolFilePath,
  validateIpcSender,
  validateRendererEventChannel,
  validateRendererInvokeCommand,
} from "../src/electron-security.ts";

test("renderer IPC commands are explicitly allowlisted", () => {
  assert.equal(ALLOWED_RENDERER_INVOKE_COMMANDS.has("sidecar_call"), true);
  assert.equal(ALLOWED_RENDERER_INVOKE_COMMANDS.has("data_export_zip"), true);
  assert.equal(ALLOWED_RENDERER_INVOKE_COMMANDS.has("write_web_log"), true);
  assert.equal(validateRendererInvokeCommand("open_external"), "open_external");
  assert.throws(
    () => validateRendererInvokeCommand("shell:run-arbitrary-command"),
    /unsupported desktop command/,
  );
  assert.throws(
    () => validateRendererInvokeCommand("desktop_get_logs_dir"),
    /unsupported desktop command/,
  );
  assert.throws(
    () => validateRendererInvokeCommand("desktop_get_native_path"),
    /unsupported desktop command/,
  );
  assert.throws(
    () => validateRendererInvokeCommand("write_log_file"),
    /unsupported desktop command/,
  );
});

test("renderer event subscriptions are explicitly allowlisted", () => {
  assert.equal(ALLOWED_RENDERER_EVENT_CHANNELS.has("sidecar:event"), true);
  assert.equal(validateRendererEventChannel("data:migrate-progress"), "data:migrate-progress");
  assert.throws(
    () => validateRendererEventChannel("lume:update:install"),
    /unsupported desktop event channel/,
  );
});

test("IPC handlers only accept the main window webContents as sender", () => {
  const trustedSender = { id: 1, isDestroyed: () => false };
  const untrustedSender = { id: 2, isDestroyed: () => false };
  const mainWindow = { isDestroyed: () => false, webContents: trustedSender };

  assert.equal(validateIpcSender({ sender: trustedSender }, mainWindow), true);
  assert.throws(
    () => validateIpcSender({ sender: untrustedSender }, mainWindow),
    /untrusted ipc sender/,
  );
  assert.throws(
    () => validateIpcSender({ sender: trustedSender }, { isDestroyed: () => true }),
    /main window is not available/,
  );
});

test("main frame navigation is restricted to the loaded app entry", () => {
  assert.equal(isAllowedMainFrameNavigation("lume://app/index.html", {
    appIsPackaged: true,
    appProtocolOrigin: "lume://app",
  }), true);
  const webEntryPath = resolve("apps/web/dist/index.html");
  const webEntryUrl = pathToFileURL(webEntryPath).href;
  assert.equal(isAllowedMainFrameNavigation(webEntryUrl, {
    appIsPackaged: true,
    appProtocolOrigin: "lume://app",
  }), false);
  assert.equal(isAllowedMainFrameNavigation("https://example.com", {
    appIsPackaged: true,
    appProtocolOrigin: "lume://app",
  }), false);
  assert.equal(isAllowedMainFrameNavigation("http://127.0.0.1:3000/settings", {
    appIsPackaged: false,
    devServerUrl: "http://127.0.0.1:3000",
  }), true);
  assert.equal(isAllowedMainFrameNavigation("http://localhost:3000/settings", {
    appIsPackaged: false,
    devServerUrl: "http://127.0.0.1:3000",
  }), false);
});

test("new windows are denied, with only http and https delegated externally", () => {
  assert.deepEqual(createWindowOpenAction("https://example.com"), {
    action: "deny",
    externalUrl: "https://example.com/",
  });
  assert.deepEqual(createWindowOpenAction("javascript:alert(1)"), {
    action: "deny",
    externalUrl: null,
  });
});

test("desktop windows use secure sandboxed web preferences", () => {
  assert.deepEqual(createSecureWebPreferences({ preload: "preload.cjs" }), {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    preload: "preload.cjs",
  });
  assert.deepEqual(createSecureWebPreferences(), {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  });
});

test("main process does not opt BrowserWindow renderers out of sandbox", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  assert.equal(mainSource.includes("sandbox: false"), false);
  assert.match(mainSource, /createSecureWebPreferences\(/);
});

test("preload bridge is compatible with Electron sandbox require limits", () => {
  const preloadSource = readFileSync(resolve(DESKTOP_ROOT, "src", "preload.ts"), "utf8");
  assert.match(preloadSource, /from ['"]electron['"]/);
  assert.equal(preloadSource.includes("node:"), false);
});

test("app protocol resolves only lume app URLs within the web root", () => {
  const webRoot = resolve("apps/web/dist");
  assert.equal(
    resolveAppProtocolFilePath("lume://app/", webRoot),
    resolve(webRoot, "index.html"),
  );
  assert.equal(
    resolveAppProtocolFilePath("lume://app/assets/index.js", webRoot),
    resolve(webRoot, "assets", "index.js"),
  );
  assert.equal(resolveAppProtocolFilePath("https://app/index.html", webRoot), null);
  assert.equal(resolveAppProtocolFilePath("lume://evil/index.html", webRoot), null);
  assert.equal(resolveAppProtocolFilePath("lume://app/%2e%2e/secret.txt", webRoot), null);
  assert.equal(resolveAppProtocolFilePath("lume://app/%5c..%5csecret.txt", webRoot), null);
});

test("preload allowlists stay in sync with main process allowlists", () => {
  const preloadSource = readFileSync(resolve(DESKTOP_ROOT, "src", "preload.ts"), "utf8");
  assert.deepEqual(
    extractStringSet(preloadSource, "ALLOWED_RENDERER_INVOKE_COMMANDS"),
    [...ALLOWED_RENDERER_INVOKE_COMMANDS],
  );
  assert.deepEqual(
    extractStringSet(preloadSource, "ALLOWED_RENDERER_EVENT_CHANNELS"),
    [...ALLOWED_RENDERER_EVENT_CHANNELS],
  );
});

test("main window uses frameless title bar with platform-specific style", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  assert.match(
    mainSource,
    /titleBarStyle:\s*process\.platform === 'darwin' \? 'hiddenInset' : 'hidden'/,
  );
});

test("main process registers a window-control IPC handler", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  assert.match(mainSource, /ipcMain\.handle\('lume:window-control'/);
});

test("main process pushes window-state events on maximize and unmaximize", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  assert.match(mainSource, /emitRendererEvent\('window-state',\s*\{\s*maximized:\s*true\s*\}\)/);
  assert.match(mainSource, /emitRendererEvent\('window-state',\s*\{\s*maximized:\s*false\s*\}\)/);
});

function extractStringSet(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!match) throw new Error(`missing preload set: ${name}`);
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1]);
}

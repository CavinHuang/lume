import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve, sep } from "node:path";

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

import {
  ALLOWED_RENDERER_EVENT_CHANNELS,
  ALLOWED_RENDERER_INVOKE_COMMANDS,
  createSecureWebPreferences,
  createWindowOpenAction,
  isAllowedMainFrameNavigation,
  resolveAppProtocolFilePath,
  resolveFileProtocolPath,
  validateIpcSender,
  validateRendererEventChannel,
  validateRendererInvokeCommand,
} from "../src/electron-security.ts";
import {
  createPreviewProtocolResponse,
  createPreviewScopeRegistry,
  injectHtmlNavigationBridge,
  isAllowedPreviewFrameNavigation,
  parseSingleRange,
  PREVIEW_PROTOCOL_MAX_MEDIA_BYTES,
  previewScopeUrl,
  resolvePreviewProtocolRequest,
} from "../src/file-protocol.ts";
import {
  computeDesktopActionHudBounds,
  createDesktopActionHudHtml,
  createDesktopActionHudView,
} from "../src/desktop-core.ts";

test("renderer IPC commands are explicitly allowlisted", () => {
  assert.equal(ALLOWED_RENDERER_INVOKE_COMMANDS.has("sidecar_call"), true);
  assert.equal(ALLOWED_RENDERER_INVOKE_COMMANDS.has("data_export_zip"), true);
  assert.equal(ALLOWED_RENDERER_INVOKE_COMMANDS.has("write_web_log"), true);
  assert.equal(ALLOWED_RENDERER_INVOKE_COMMANDS.has("quick_input_get_context"), true);
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

test("preview scopes bind unguessable tokens to one webContents owner and expire", () => {
  let now = 1_000;
  const registry = createPreviewScopeRegistry({ now: () => now });
  const root = mkdtempSync(join(tmpdir(), "lume-preview-owner-"));
  const entry = join(root, "index.html");
  writeFileSync(entry, "<h1>ok</h1>");
  const scope = registry.create({ kind: "html-directory", ownerWebContentsId: 7, absolutePath: entry, ttlMs: 100 });

  assert.match(scope.token, /^[a-f0-9]{64}$/);
  assert.equal(registry.owns(scope.token, 7), true);
  assert.equal(registry.owns(scope.token, 8), false);
  now = 1_101;
  assert.equal(registry.owns(scope.token, 7), false);
});

test("HTML preview resolution stays inside its directory and static allowlist", () => {
  const root = mkdtempSync(join(tmpdir(), "lume-preview-html-"));
  const child = join(root, "assets");
  mkdirSync(child);
  writeFileSync(join(root, "index.html"), "<script src='./app.js'></script>");
  writeFileSync(join(root, "app.js"), "globalThis.loaded = true");
  writeFileSync(join(child, "style.css"), "body{}");
  writeFileSync(join(root, ".env"), "SECRET=1");
  const registry = createPreviewScopeRegistry();
  const scope = registry.create({
    kind: "html-directory",
    ownerWebContentsId: 1,
    absolutePath: join(root, "index.html"),
  });

  const allowed = resolvePreviewProtocolRequest(registry, `lume-file://preview/${scope.token}/assets/style.css`, "GET");
  assert.equal(allowed.kind, "ok");
  if (allowed.kind === "ok") {
    assert.equal(allowed.headers["Cache-Control"], "no-store");
    assert.equal(allowed.headers["X-Content-Type-Options"], "nosniff");
    assert.equal(allowed.headers["Access-Control-Allow-Origin"], "*");
    assert.equal("Access-Control-Allow-Credentials" in allowed.headers, false);
  }
  assert.equal(resolvePreviewProtocolRequest(registry, `lume-file://preview/${scope.token}/../secret.txt`, "GET").kind, "forbidden");
  assert.equal(resolvePreviewProtocolRequest(registry, `lume-file://preview/${scope.token}/.env`, "GET").kind, "forbidden");
  assert.equal(resolvePreviewProtocolRequest(registry, `lume-file://preview/${scope.token}/README`, "GET").kind, "forbidden");
});

test("HTML navigation bridge leaves fragments local and emits only typed link messages", () => {
  const injected = injectHtmlNavigationBridge("<html><head></head><body></body></html>");
  assert.match(injected, /href\.startsWith\('#'\)/);
  assert.match(injected, /type:'lume-preview-link'/);
  assert.match(injected, /kind,href/);
  assert.equal(injected.includes("allow-same-origin"), false);
});

test("preview subframes may stay on the entry URL or its fragment only", () => {
  const root = mkdtempSync(join(tmpdir(), "lume-preview-navigation-"));
  const entry = join(root, "index.html");
  writeFileSync(entry, "<h1>entry</h1>");
  writeFileSync(join(root, "other.html"), "<h1>other</h1>");
  const registry = createPreviewScopeRegistry();
  const scope = registry.create({ kind: "html-directory", ownerWebContentsId: 9, absolutePath: entry });
  const url = previewScopeUrl(scope);

  assert.equal(isAllowedPreviewFrameNavigation(registry, url, 9), true);
  assert.equal(isAllowedPreviewFrameNavigation(registry, `${url}#section`, 9), true);
  assert.equal(isAllowedPreviewFrameNavigation(registry, url.replace("index.html", "other.html"), 9), false);
  assert.equal(isAllowedPreviewFrameNavigation(registry, url, 10), false);
  assert.equal(isAllowedPreviewFrameNavigation(registry, "https://example.com", 9), false);
});

test("media scopes authorize one image file and validate single byte ranges", () => {
  const root = mkdtempSync(join(tmpdir(), "lume-preview-media-"));
  const image = join(root, "image.png");
  const other = join(root, "other.png");
  writeFileSync(image, Buffer.alloc(20));
  writeFileSync(other, Buffer.alloc(20));
  const registry = createPreviewScopeRegistry();
  const scope = registry.create({ kind: "media-file", ownerWebContentsId: 4, absolutePath: image });

  assert.equal(resolvePreviewProtocolRequest(registry, `lume-file://preview/${scope.token}/image.png`, "HEAD").kind, "ok");
  assert.equal(resolvePreviewProtocolRequest(registry, `lume-file://preview/${scope.token}/other.png`, "GET").kind, "forbidden");
  assert.deepEqual(parseSingleRange("bytes=3-8", 20), { start: 3, end: 8 });
  assert.deepEqual(parseSingleRange("bytes=-5", 20), { start: 15, end: 19 });
  assert.equal(parseSingleRange("bytes=1-2,4-5", 20), null);
  assert.equal(parseSingleRange("bytes=30-40", 20), null);
});

test("preview protocol responses implement media HEAD and single-range semantics", async () => {
  const root = mkdtempSync(join(tmpdir(), "lume-preview-response-"));
  const image = join(root, "image.png");
  writeFileSync(image, Buffer.from("0123456789"));
  const registry = createPreviewScopeRegistry();
  const scope = registry.create({ kind: "media-file", ownerWebContentsId: 4, absolutePath: image });
  const url = previewScopeUrl(scope);

  const partial = await createPreviewProtocolResponse(registry, new Request(url, { headers: { Range: "bytes=2-5" } }));
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await partial.text(), "2345");
  const invalid = await createPreviewProtocolResponse(registry, new Request(url, { headers: { Range: "bytes=20-30" } }));
  assert.equal(invalid.status, 416);
  const head = await createPreviewProtocolResponse(registry, new Request(url, { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("accept-ranges"), "bytes");
  assert.equal(head.headers.get("x-content-type-options"), "nosniff");

  const oversized = join(root, "oversized.png");
  writeFileSync(oversized, "x");
  truncateSync(oversized, PREVIEW_PROTOCOL_MAX_MEDIA_BYTES + 1);
  const oversizedScope = registry.create({ kind: "media-file", ownerWebContentsId: 4, absolutePath: oversized });
  assert.equal(resolvePreviewProtocolRequest(registry, previewScopeUrl(oversizedScope), "GET").kind, "too-large");

  const growing = join(root, "growing.png");
  writeFileSync(growing, "0123456789");
  const growingScope = registry.create({ kind: "media-file", ownerWebContentsId: 4, absolutePath: growing });
  const growingResponse = await createPreviewProtocolResponse(registry, new Request(previewScopeUrl(growingScope)));
  truncateSync(growing, PREVIEW_PROTOCOL_MAX_MEDIA_BYTES + 1);
  await assert.rejects(() => growingResponse.arrayBuffer(), /byte limit|terminated|aborted/i);

  const entry = join(root, "index.html");
  const emptyScript = join(root, "empty.js");
  writeFileSync(entry, "<html></html>");
  writeFileSync(emptyScript, "");
  const htmlScope = registry.create({ kind: "html-directory", ownerWebContentsId: 4, absolutePath: entry });
  const emptyResponse = await createPreviewProtocolResponse(
    registry,
    new Request(`lume-file://preview/${htmlScope.token}/empty.js`),
  );
  assert.equal(emptyResponse.status, 200);
  assert.equal(await emptyResponse.text(), "");
});

test("main installs one owner gate and enables CORS only on the preview protocol", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  assert.equal((mainSource.match(/webRequest\.onBeforeRequest/g) ?? []).length, 1);
  assert.match(mainSource, /previewScopes\.owns\(token, details\.webContentsId\)/);
  const schemeRegistrations = mainSource.slice(
    mainSource.indexOf("protocol.registerSchemesAsPrivileged"),
    mainSource.indexOf("const sidecarHost"),
  );
  assert.equal((schemeRegistrations.match(/corsEnabled:\s*true/g) ?? []).length, 1);
});

test("renderer event subscriptions are explicitly allowlisted", () => {
  assert.equal(ALLOWED_RENDERER_EVENT_CHANNELS.has("sidecar:event"), true);
  assert.equal(ALLOWED_RENDERER_EVENT_CHANNELS.has("window-state"), true);
  assert.equal(validateRendererEventChannel("data:migrate-progress"), "data:migrate-progress");
  assert.throws(
    () => validateRendererEventChannel("lume:update:install"),
    /unsupported desktop event channel/,
  );
});

test("IPC handlers only accept trusted window webContents as sender", () => {
  const mainSender = { id: 1, isDestroyed: () => false };
  const quickSender = { id: 2, isDestroyed: () => false };
  const unknownSender = { id: 3, isDestroyed: () => false };
  const mainWindow = { isDestroyed: () => false, webContents: mainSender };
  const quickWindow = { isDestroyed: () => false, webContents: quickSender };

  // 单窗口向后兼容
  assert.equal(validateIpcSender({ sender: mainSender }, mainWindow), true);
  assert.throws(
    () => validateIpcSender({ sender: unknownSender }, mainWindow),
    /untrusted ipc sender/,
  );
  assert.throws(
    () => validateIpcSender({ sender: mainSender }, { isDestroyed: () => true }),
    /no trusted window available/,
  );

  // 窗口数组：main 与 quickInput 都受信任
  assert.equal(
    validateIpcSender({ sender: mainSender }, [mainWindow, quickWindow]),
    true,
  );
  assert.equal(
    validateIpcSender({ sender: quickSender }, [mainWindow, quickWindow]),
    true,
  );
  assert.throws(
    () => validateIpcSender({ sender: unknownSender }, [mainWindow, quickWindow]),
    /untrusted ipc sender/,
  );

  // 空数组或全 null：拒绝
  assert.throws(
    () => validateIpcSender({ sender: mainSender }, []),
    /no trusted window available/,
  );
  assert.throws(
    () => validateIpcSender({ sender: mainSender }, [null, null]),
    /no trusted window available/,
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

test("main process opens DevTools only for development windows", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  const devToolsIndex = mainSource.indexOf("win.webContents.openDevTools({ mode: 'detach' })");
  const devGuardIndex = mainSource.indexOf("if (!app.isPackaged) {");
  const packagedLoadIndex = mainSource.indexOf("await win.loadURL(getPackagedAppUrl())");

  assert.notEqual(devToolsIndex, -1, "development DevTools opener is missing");
  assert.notEqual(devGuardIndex, -1, "DevTools opener must be guarded by app.isPackaged");
  assert.notEqual(packagedLoadIndex, -1, "packaged load branch is missing");
  assert.equal(devGuardIndex < devToolsIndex, true, "DevTools must only open inside the dev guard");
  assert.equal(packagedLoadIndex < devToolsIndex, true, "DevTools must not open before packaged load branch");
});

test("main process routes desktop proposal notifications through a scrubbed helper", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");

  assert.match(mainSource, /desktop-context:proposal-created/);
  assert.match(mainSource, /desktop-context:proposal-open-request/);
  assert.match(mainSource, /createDesktopProposalNotification/);
  assert.match(mainSource, /createDesktopProposalOpenRequest/);
  assert.match(mainSource, /\.on\('click'/);
  assert.match(mainSource, /new Notification/);
});

test("main window is registered before its renderer can invoke IPC", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  const registerIndex = mainSource.indexOf("mainWindow = win");
  const loadIndex = mainSource.indexOf("await win.loadURL");

  assert.notEqual(registerIndex, -1, "main window is never registered during creation");
  assert.equal(registerIndex < loadIndex, true, "main window must be registered before loading its renderer");
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

test("main process registers Alt+L global shortcut after app ready", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  assert.match(mainSource, /globalShortcut\.register\(['"]Alt\+L['"]/);
  assert.match(mainSource, /globalShortcut\.unregisterAll\(\)/);
});

test("desktop action HUD projects only non-sensitive action metadata", () => {
  const view = createDesktopActionHudView("agent:runtime-event", {
    threadId: "thread-1",
    event: {
      type: "desktop.action_visual",
      phase: "started",
      action: "type_text",
      app: { id: "wechat.exe", name: "微信" },
      targetLabel: "消息输入框",
      point: { x: 620, y: 480 },
      text: "must-not-leak",
      args: { text: "must-not-leak" },
    },
  });

  assert.deepEqual(view, {
    phase: "started",
    title: "Lume 正在操作",
    actionLabel: "输入内容",
    appName: "微信",
    targetLabel: "消息输入框",
    point: { x: 620, y: 480 },
  });
  assert.equal(JSON.stringify(view).includes("must-not-leak"), false);
  assert.equal(createDesktopActionHudView("other", { event: {} }), null);
});

test("desktop action HUD escapes labels and stays inside the target display", () => {
  const html = createDesktopActionHudHtml({
    phase: "failed",
    title: "操作未完成",
    actionLabel: "点击",
    appName: "微信",
    targetLabel: '<img src=x onerror="alert(1)">',
    status: "failed",
  });
  const bounds = computeDesktopActionHudBounds(
    { x: 1920, y: 0, width: 1280, height: 720 },
    { width: 420, height: 86 },
  );

  assert.equal(html.includes("<img src=x"), false);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.deepEqual(bounds, { x: 2350, y: 28, width: 420, height: 86 });
});

test("desktop action HUD uses a click-through cross-app overlay window", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");

  assert.match(mainSource, /function showDesktopActionHud\(method, params\)/);
  assert.match(mainSource, /alwaysOnTop:\s*true/);
  assert.match(mainSource, /transparent:\s*true/);
  assert.match(mainSource, /focusable:\s*false/);
  assert.match(mainSource, /setIgnoreMouseEvents\(true/);
  assert.match(mainSource, /showInactive\(\)/);
});

test("quick input window is registered before its renderer loads", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  const registerIndex = mainSource.indexOf("quickInputWindow = win");
  const loadIndex = mainSource.indexOf("getQuickInputUrl(");
  assert.notEqual(registerIndex, -1, "quick input window is never assigned");
  assert.notEqual(loadIndex, -1, "quick input window never loads its url");
  assert.equal(registerIndex < loadIndex, true, "quick input window must register before load");
});

test("dispatchCommand handles quick_input_hide", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  assert.match(mainSource, /case 'quick_input_hide'/);
});

test("dispatchCommand exposes only prepared quick-input context metadata", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  assert.match(mainSource, /case 'quick_input_get_context'/);
  assert.match(mainSource, /latestQuickInputContext/);
});

test("main window blur remembers only foreground metadata for a later user-initiated capture", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  const start = mainSource.indexOf("function attachWindowBehavior");
  const end = mainSource.indexOf("function attachWebContentsSecurity", start);
  const body = mainSource.slice(start, end);

  assert.match(body, /win\.on\('blur'/);
  assert.match(body, /rememberForegroundDesktopTarget/);
  assert.doesNotMatch(body, /captureQuickInputContext/);
});

test("showMainWindow pre-captures desktop context before Lume steals focus", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  const start = mainSource.indexOf("function showMainWindow()");
  const end = mainSource.indexOf("function attachWindowBehavior", start);
  assert.notEqual(start, -1, "showMainWindow is missing");
  assert.notEqual(end, -1, "attachWindowBehavior marker is missing");
  const body = mainSource.slice(start, end);
  const captureIndex = body.indexOf("captureQuickInputContext()");
  const restoreIndex = body.indexOf("restoreMainWindow(mainWindow)");
  assert.notEqual(captureIndex, -1, "showMainWindow does not capture desktop context");
  assert.notEqual(restoreIndex, -1, "showMainWindow does not restore the main window");
  assert.equal(captureIndex < restoreIndex, true, "desktop context must be captured before Lume receives focus");
});

test("cold start pre-captures desktop context before creating the Lume window", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  const start = mainSource.indexOf("app.whenReady().then(async () => {");
  const end = mainSource.indexOf("}).catch((error) => {", start);
  assert.notEqual(start, -1, "app ready handler is missing");
  assert.notEqual(end, -1, "app ready handler end marker is missing");
  const body = mainSource.slice(start, end);
  const captureIndex = body.indexOf("captureQuickInputContext()");
  const createIndex = body.indexOf("createMainWindow()");
  assert.notEqual(captureIndex, -1, "cold start does not capture desktop context");
  assert.notEqual(createIndex, -1, "cold start does not create the main window");
  assert.equal(captureIndex < createIndex, true, "desktop context must be captured before Lume receives focus");
});

test("app activation pre-captures desktop context before recreating the Lume window", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  const start = mainSource.indexOf("app.on('activate', async () => {");
  const end = mainSource.indexOf("app.on('before-quit'", start);
  assert.notEqual(start, -1, "app activate handler is missing");
  assert.notEqual(end, -1, "app activate handler end marker is missing");
  const body = mainSource.slice(start, end);
  const captureIndex = body.indexOf("captureQuickInputContext()");
  const createIndex = body.indexOf("createMainWindow()");
  assert.notEqual(captureIndex, -1, "app activation does not capture desktop context");
  assert.notEqual(createIndex, -1, "app activation does not recreate the main window");
  assert.equal(captureIndex < createIndex, true, "desktop context must be captured before Lume receives focus");
});

function extractStringSet(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!match) throw new Error(`missing preload set: ${name}`);
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1]);
}

const ROOT = mkdtempSync(join(tmpdir(), "lume-file-"));
const IMG = resolve(ROOT, "a.png");
writeFileSync(IMG, "x");
// 跨平台分隔符的白名单前缀（确保 startsWith + sep 生效）
const ROOT_PREFIX = ROOT.endsWith(sep) ? ROOT : ROOT + sep;

test("resolveFileProtocolPath: 合法绝对路径返回 ok", () => {
  const url = `lume-file://file/${encodeURIComponent(IMG)}`;
  assert.deepEqual(resolveFileProtocolPath(url, ROOT), { kind: "ok", absPath: realpathSync(IMG) });
});

test("resolveFileProtocolPath: 正斜杠路径变体返回 ok（跨平台正向用例）", () => {
  // 构造一个不含 `\` 的合法路径 URL：encodeURIComponent(ROOT) 在 Windows 上
  // 把 `\` 编码为 %5C（删除 %5c 校验后能通过第一层），末尾的字面 `/a.png` 保留
  // 正斜杠（不被 encodeURIComponent 包裹，因此不产生 %2F）。这条用例确保
  // 第二层白名单 + realpath 校验在 Windows 上被真正测到，不依赖 %5c 校验存在与否。
  const url = `lume-file://file/${encodeURIComponent(ROOT)}/a.png`;
  const result = resolveFileProtocolPath(url, ROOT);
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    // realpath 后应等于 IMG 的绝对路径
    assert.equal(result.absPath, realpathSync(IMG));
  }
});

test("resolveFileProtocolPath: 白名单根外返回 forbidden", () => {
  const outside = resolve(ROOT, "..", "secret.png");
  const url = `lume-file://file/${encodeURIComponent(outside)}`;
  assert.equal(resolveFileProtocolPath(url, ROOT).kind, "forbidden");
});

test("resolveFileProtocolPath: %2e%2e 编码攻击返回 forbidden", () => {
  const url = `lume-file://file/${ROOT_PREFIX}%2e%2e%2fsecret`;
  assert.equal(resolveFileProtocolPath(url, ROOT).kind, "forbidden");
});

test("resolveFileProtocolPath: %5c..%5c 返回 forbidden", () => {
  const url = `lume-file://file/${encodeURIComponent(ROOT)}%5c..%5csecret`;
  assert.equal(resolveFileProtocolPath(url, ROOT).kind, "forbidden");
});

test("resolveFileProtocolPath: %00 返回 forbidden", () => {
  const url = `lume-file://file/${encodeURIComponent(IMG)}%00`;
  assert.equal(resolveFileProtocolPath(url, ROOT).kind, "forbidden");
});

test("resolveFileProtocolPath: UNC 路径返回 forbidden", () => {
  const url = `lume-file://file/${encodeURIComponent("\\\\server\\share\\x.png")}`;
  assert.equal(resolveFileProtocolPath(url, ROOT).kind, "forbidden");
});

test("resolveFileProtocolPath: symlink 越界返回 forbidden", (t) => {
  const linkDir = mkdtempSync(join(tmpdir(), "lume-out-"));
  const target = resolve(linkDir, "secret.png");
  writeFileSync(target, "x");
  const link = resolve(ROOT, "link.png");
  try {
    symlinkSync(target, link);
  } catch (error) {
    // 显式 skip：无权限创建 symlink 的环境（如 Windows 非管理员无 Developer Mode）
    // 不能让本用例"伪 pass"——用 node:test 的 skip 机制明确标注。
    const reason = error instanceof Error ? error.message : String(error);
    t.skip(`symlink creation unavailable on this platform (${reason})`);
    return;
  }
  const url = `lume-file://file/${encodeURIComponent(link)}`;
  assert.equal(resolveFileProtocolPath(url, ROOT).kind, "forbidden");
});

test("resolveFileProtocolPath: 不存在返回 notfound", () => {
  const url = `lume-file://file/${encodeURIComponent(resolve(ROOT, "nope.png"))}`;
  assert.equal(resolveFileProtocolPath(url, ROOT).kind, "notfound");
});

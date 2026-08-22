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
  validateRendererSidecarMethod,
} from "../src/electron-security.ts";
import { PUBLIC_RENDERER_SIDECAR_METHODS } from "../src/renderer-sidecar-methods.ts";
import { LOCAL_RENDERER_SIDECAR_METHODS } from '@lume/shared';
import {
  createPluginAssetRegistry,
  pluginAssetTokenFromUrl,
  scopePluginAssetUrls,
} from "../src/plugin-asset-registry.ts";
import * as sharedIpc from '@lume/shared';
import { BROWSER_IPC_CHANNELS } from '@lume/shared';
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
  assert.equal(ALLOWED_RENDERER_INVOKE_COMMANDS.has("desktop:save-plugin-package"), true);
  assert.equal(ALLOWED_RENDERER_INVOKE_COMMANDS.has("desktop:install-plugin-package"), true);
  assert.equal(ALLOWED_RENDERER_INVOKE_COMMANDS.has("data_export_zip"), true);
  assert.equal(ALLOWED_RENDERER_INVOKE_COMMANDS.has("write_web_log"), true);
  assert.equal(ALLOWED_RENDERER_INVOKE_COMMANDS.has("quick_input_get_context"), true);
  assert.equal(ALLOWED_RENDERER_INVOKE_COMMANDS.has("desktop_report_tray_navigation_confirmation_failed"), true);
  assert.equal(ALLOWED_RENDERER_INVOKE_COMMANDS.has("open_guarded_file_ref"), true);
  assert.equal(ALLOWED_RENDERER_INVOKE_COMMANDS.has("reveal_guarded_file_ref"), true);
  assert.equal(ALLOWED_RENDERER_INVOKE_COMMANDS.has("save_guarded_file_ref_as"), true);
  assert.equal(ALLOWED_RENDERER_INVOKE_COMMANDS.has("create_guarded_file_preview_scope"), true);
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

test("renderer sidecar allowlist equals shared derived channels plus local increment (bidirectional)", () => {
  // 测试内独立重算派生规则（不走 renderer-allowlist.ts 的 PUBLIC_CHANNEL_SOURCES），
  // 绊住"新增通道常量但 source 列表漏配"；再并上 shared 导出的本地增量，与桌面侧
  // Set 双向 ==：漏配/私加条目（含死条目）两个方向都会红。
  // RENDERER_BLOCKED_CHANNEL_VALUES：源路径收口，copy-folder 系列不允许 renderer 直达
  //（与 renderer-allowlist.ts 的排除集逐字一致）。
  const blocked = new Set([
    sharedIpc.AGENT_IPC_CHANNELS.COPY_FOLDER_TO_THREAD,
    sharedIpc.AGENT_IPC_CHANNELS.COPY_FOLDER_TO_WORKSPACE,
  ]);
  const sharedMethods = Object.entries(sharedIpc)
    .filter(([name, value]) => name.endsWith("IPC_CHANNELS") && name !== "PLUGIN_PACKAGE_PRIVILEGED_IPC_CHANNELS" && name !== "AGENT_ISLAND_IPC_CHANNELS" && value && typeof value === "object")
    .flatMap(([, value]) => Object.entries(value))
    .filter(([key, value]) => key !== "CHANGED" && key !== "REMINDER_DUE" && key !== "EVENTS" && typeof value === "string" && !value.includes(":privileged-") && !Object.values(BROWSER_IPC_CHANNELS).includes(value) && !blocked.has(value))
    .map(([, value]) => value);
  const expected = new Set([...sharedMethods, ...LOCAL_RENDERER_SIDECAR_METHODS]);
  assert.deepEqual(
    [...PUBLIC_RENDERER_SIDECAR_METHODS].sort(),
    [...expected].sort(),
  );
  assert.equal(PUBLIC_RENDERER_SIDECAR_METHODS.has(sharedIpc.AGENT_IPC_CHANNELS.COPY_FOLDER_TO_THREAD), false);
  assert.equal(PUBLIC_RENDERER_SIDECAR_METHODS.has(sharedIpc.AGENT_IPC_CHANNELS.COPY_FOLDER_TO_WORKSPACE), false);
});

test("renderer may inspect browser backend availability without invoking browser actions", () => {
  assert.equal(validateRendererSidecarMethod("browser:backends"), "browser:backends");
  assert.equal(validateRendererSidecarMethod("browser:reference-candidates"), "browser:reference-candidates");
  assert.equal(validateRendererSidecarMethod("browser:create-reference-grant"), "browser:create-reference-grant");
  assert.equal(validateRendererSidecarMethod("browser:revoke-reference-grant"), "browser:revoke-reference-grant");
  assert.throws(() => validateRendererSidecarMethod("browser:broker"), /unsupported renderer sidecar method/);
});

test("plugin package writes are main-owned and unavailable through generic RPC", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  assert.throws(() => validateRendererSidecarMethod("plugin-package:privileged-finalize"), /privileged RPC/);
  assert.throws(() => validateRendererSidecarMethod("agent:download-bridge-asset"), /privileged RPC/);
  assert.equal(validateRendererSidecarMethod("agent:get-market-catalog"), "agent:get-market-catalog");
  assert.throws(() => validateRendererSidecarMethod("future:unreviewed-method"), /unsupported renderer sidecar method/);
  assert.match(mainSource, /desktop:save-plugin-package/);
  assert.match(mainSource, /desktop:install-plugin-package/);
  assert.match(mainSource, /createChromeNativeHostInstallPlan/);
  assert.match(mainSource, /showSaveDialog/);
  assert.match(mainSource, /plugin-package:privileged-finalize/);
});

test("plugin image data is exchanged for owner-scoped protocol URLs", () => {
  let now = 1_000;
  const registry = createPluginAssetRegistry({ now: () => now, ttlMs: 100 });
  const dataUrl = `data:image/png;base64,${Buffer.from("logo").toString("base64")}`;
  const scoped = scopePluginAssetUrls(registry, "agent:get-market-catalog", {
    plugin: { marketplace: { icon: { url: dataUrl } } },
  }, 7);
  const scopedUrl = scoped.plugin.marketplace.icon.url;
  const token = pluginAssetTokenFromUrl(scopedUrl);

  assert.match(scopedUrl, /^lume-file:\/\/plugin-asset\/[a-f0-9]{64}$/);
  assert.equal(registry.owns(token, 7), true);
  assert.equal(registry.owns(token, 8), false);
  assert.equal(registry.get(token)?.bytes.toString(), "logo");
  assert.equal(registry.registerDataUrl(7, dataUrl), scopedUrl);
  assert.equal(scopePluginAssetUrls(registry, "agent:list-threads", dataUrl, 7), dataUrl);
  assert.equal(scopePluginAssetUrls(registry, "agent:get-market-detail", "data:image/bmp;base64,YQ==", 7), null);

  now = 1_101;
  assert.equal(registry.owns(token, 7), false);
});

test("plugin image registry enforces per-asset and owner quotas", () => {
  const registry = createPluginAssetRegistry({ maxAssetBytes: 4, maxOwnerBytes: 5, maxTotalBytes: 8 });
  const image = (value) => `data:image/png;base64,${Buffer.from(value).toString("base64")}`;

  registry.registerDataUrl(1, image("1234"));
  assert.throws(() => registry.registerDataUrl(1, image("12")), /quota exceeded/);
  assert.throws(() => registry.registerDataUrl(2, image("12345")), /invalid plugin image payload/);
  registry.registerDataUrl(2, image("1234"));
  assert.throws(() => registry.registerDataUrl(3, image("1")), /quota exceeded/);
});

test("guarded preview scopes retain their mandatory guard for per-request revalidation", () => {
  const registry = createPreviewScopeRegistry();
  const root = mkdtempSync(join(tmpdir(), "lume-preview-guarded-"));
  const entry = join(root, "image.png");
  writeFileSync(entry, "image");
  const guardedRef = {
    ref: { source: "project", scopeId: "demo", relativePath: "image.png" },
    expectedKind: "file",
    guard: {
      kind: "project",
      workspaceSlug: "demo",
      expectedProjectRootFingerprint: "a".repeat(64),
      consumerThreadId: "thread-1",
    },
  };
  const scope = registry.create({ kind: "media-file", ownerWebContentsId: 7, absolutePath: entry, guardedRef });
  assert.deepEqual(registry.get(scope.token)?.guardedRef, guardedRef);
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

test("media scopes authorize one image, PDF, or video file and validate single byte ranges", () => {
  const root = mkdtempSync(join(tmpdir(), "lume-preview-media-"));
  const image = join(root, "image.png");
  const other = join(root, "other.png");
  const pdf = join(root, "manual.pdf");
  const video = join(root, "movie.mp4");
  writeFileSync(image, Buffer.alloc(20));
  writeFileSync(other, Buffer.alloc(20));
  writeFileSync(pdf, Buffer.alloc(20));
  writeFileSync(video, Buffer.alloc(20));
  const registry = createPreviewScopeRegistry();
  const scope = registry.create({ kind: "media-file", ownerWebContentsId: 4, absolutePath: image });

  assert.equal(resolvePreviewProtocolRequest(registry, `lume-file://preview/${scope.token}/image.png`, "HEAD").kind, "ok");
  assert.equal(resolvePreviewProtocolRequest(registry, `lume-file://preview/${scope.token}/other.png`, "GET").kind, "forbidden");
  const pdfScope = registry.create({ kind: "media-file", ownerWebContentsId: 4, absolutePath: pdf });
  const videoScope = registry.create({ kind: "media-file", ownerWebContentsId: 4, absolutePath: video });
  assert.equal(resolvePreviewProtocolRequest(registry, previewScopeUrl(pdfScope), "GET").mimeType, "application/pdf");
  assert.equal(resolvePreviewProtocolRequest(registry, previewScopeUrl(videoScope), "GET").mimeType, "video/mp4");
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

  // #128:html-directory 的超限 .html 在 resolve 侧放行(kind=ok),由响应侧 fstat 拦截为 413
  const oversizedHtml = join(root, "oversized.html");
  writeFileSync(oversizedHtml, "<html></html>");
  truncateSync(oversizedHtml, PREVIEW_PROTOCOL_MAX_MEDIA_BYTES + 1);
  const oversizedHtmlScope = registry.create({ kind: "html-directory", ownerWebContentsId: 4, absolutePath: oversizedHtml });
  assert.equal(resolvePreviewProtocolRequest(registry, previewScopeUrl(oversizedHtmlScope), "GET").kind, "ok");
  assert.equal((await createPreviewProtocolResponse(registry, new Request(previewScopeUrl(oversizedHtmlScope)))).status, 413);
  assert.equal((await createPreviewProtocolResponse(registry, new Request(previewScopeUrl(oversizedHtmlScope), { method: "HEAD" }))).status, 413);

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
  assert.match(mainSource, /pluginAssets\.owns\(token, details\.webContentsId\)/);
  const schemeRegistrations = mainSource.slice(
    mainSource.indexOf("protocol.registerSchemesAsPrivileged"),
    mainSource.indexOf("const sidecarHost"),
  );
  assert.equal((schemeRegistrations.match(/corsEnabled:\s*true/g) ?? []).length, 1);
});

test("main revalidates guarded preview scopes and guarded file actions through sidecar", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  assert.match(mainSource, /scope\?\.guardedRef/);
  assert.match(mainSource, /agent:resolve-guarded-file-ref/);
  assert.match(mainSource, /case 'create_guarded_file_preview_scope'/);
  assert.match(mainSource, /guardedRef: payload\.guardedRef/);
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
  assert.deepEqual(createSecureWebPreferences({ preload: "preload.cjs", webviewTag: true }), {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webviewTag: true,
    preload: "preload.cjs",
  });
});

test("connection credential reveal remains main-process privileged", () => {
  assert.throws(() => validateRendererSidecarMethod("channel:privileged-decrypt-key"), /unsupported renderer sidecar method/);
});

test("browser webview guests are one-time authorized and receive no host bridge", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  const guestPreloadSource = readFileSync(resolve(DESKTOP_ROOT, "src", "browser-guest-preload.tsx"), "utf8");
  assert.match(mainSource, /will-attach-webview/);
  assert.match(mainSource, /authorizeGuestMount/);
  assert.match(mainSource, /did-attach-webview/);
  assert.match(mainSource, /browser-guest-preload\.cjs/);
  assert.match(mainSource, /params\.allowpopups = ['"]{2}/);
  assert.match(mainSource, /ipcMain\.on\('lume:browser-guest-mounted'/);
  // guest-preload 不得向 page 暴露任意 host bridge。Task 82 起唯一允许的受审例外是
  // Web MCP shim（__lumeWebMcpModelContext，frozen、仅 registerTool/getTools/executeTool
  // 等受限方法）。锁定 exposeInMainWorld 的所有引用键名均为 __lumeWebMcpModelContext，
  // 防止新增未审 bridge（代码与文档注释一并检查）。
  const exposeCalls = [...guestPreloadSource.matchAll(/exposeInMainWorld\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(exposeCalls.length > 0 && exposeCalls.every((k) => k === "__lumeWebMcpModelContext"), `guest-preload 仅允许暴露 __lumeWebMcpModelContext，实际暴露：${JSON.stringify(exposeCalls)}`);
  assert.match(guestPreloadSource, /ipcRenderer\.send\('lume:browser-guest-mounted'/);
});

test("renderer browser guest pool never reparents an attached webview", () => {
  const poolSource = readFileSync(resolve(DESKTOP_ROOT, "..", "web", "src", "components", "browser", "BrowserWebviewPool.tsx"), "utf8");
  assert.match(poolSource, /BROWSER_GUEST_HOST_ID = 'lume-browser-webview-pool'/);
  assert.match(poolSource, /document\.body\.append\(host\)/);
  assert.match(poolSource, /lumePendingMounts/);
  assert.match(poolSource, /await pending/);
  assert.match(poolSource, /api\.recover\(tabId/);
  assert.match(poolSource, /wrapper\.style\.position = 'fixed'/);
  assert.match(poolSource, /wrapper\.style\.visibility = 'hidden'/);
  assert.match(poolSource, /webview\.setAttribute\('allowpopups', ''\)/);
  assert.doesNotMatch(poolSource, /wrapper\.style\.display = 'none'/);
  assert.doesNotMatch(poolSource, /append\(existing\.wrapper\)/);
  assert.doesNotMatch(poolSource, /append\(entry\.wrapper\)/);
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
  const packagedLoadIndex = mainSource.indexOf("return getPackagedAppUrl()");

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

test("browser auth preload sends secrets only through its dedicated main-process channel", () => {
  const preloadSource = readFileSync(resolve(DESKTOP_ROOT, "src", "browser-auth-preload.ts"), "utf8");
  assert.match(preloadSource, /from ['"]electron['"]/);
  assert.match(preloadSource, /ipcRenderer\.send\(['"]lume:browser-auth['"]/);
  assert.equal(preloadSource.includes("ipcRenderer.invoke"), false);
  assert.equal(preloadSource.includes("node:"), false);
  assert.equal(preloadSource.includes("navigator.clipboard"), false);
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

test("preload and main process share the single renderer-ipc-contract source", () => {
  // 双端白名单已抽到 renderer-ipc-contract.ts 单源；本测试守卫双端 import 同一模块，
  // 且不得回归为各自的本地 Set 字面量（双份手工维护）。
  const preloadSource = readFileSync(resolve(DESKTOP_ROOT, "src", "preload.ts"), "utf8");
  const securitySource = readFileSync(resolve(DESKTOP_ROOT, "src", "electron-security.ts"), "utf8");
  assert.match(preloadSource, /from ['"]\.\/renderer-ipc-contract['"]/);
  assert.match(securitySource, /from ['"]\.\/renderer-ipc-contract['"]/);
  assert.doesNotMatch(preloadSource, /ALLOWED_RENDERER_INVOKE_COMMANDS\s*=\s*new Set/);
  assert.doesNotMatch(securitySource, /ALLOWED_RENDERER_INVOKE_COMMANDS\s*=\s*new Set/);
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
  const restoreIndex = body.indexOf("ensureMainWindowVisible()");
  assert.notEqual(captureIndex, -1, "showMainWindow does not capture desktop context");
  assert.notEqual(restoreIndex, -1, "showMainWindow does not ensure the main window is visible");
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

test("app quit synchronously destroys the non-closable agent island surface", () => {
  const mainSource = readFileSync(resolve(DESKTOP_ROOT, "src", "main.ts"), "utf8");
  const start = mainSource.indexOf("app.on('before-quit', () => {");
  const end = mainSource.indexOf("app.on('window-all-closed'", start);
  assert.notEqual(start, -1, "app before-quit handler is missing");
  assert.notEqual(end, -1, "app before-quit handler end marker is missing");
  const body = mainSource.slice(start, end);
  const destroyServiceIndex = body.indexOf("agentIslandService?.destroy()");
  const destroySurfaceIndex = body.indexOf("stopAgentIslandSurface()");
  assert.notEqual(destroyServiceIndex, -1, "before-quit does not destroy the agent island service");
  assert.notEqual(destroySurfaceIndex, -1, "before-quit does not destroy the agent island surface");
  assert.equal(destroyServiceIndex < destroySurfaceIndex, true, "agent island service must stop before its surface");
  assert.match(
    mainSource,
    /ensureIslandWindow:\s*\(\(\)\s*=>\s*\(isQuitting\s*\|\|\s*nativeSurfaceActive\s*\?\s*null\s*:\s*ensureIslandWindow\(\)\)\)/,
    "agent island window can be recreated while the app is quitting",
  );
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

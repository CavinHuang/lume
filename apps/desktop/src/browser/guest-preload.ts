/**
 * guest 侧 preload 源码 —— 字符串导出,集成者在构建期写入
 * `dist/preload/browser-guest-preload.cjs`(webview will-attach 时由 ipc.ts 强制注入)。
 *
 * 职责(ZCode out/preload/embeddedBrowserJavaScriptDialog.cjs 的 Lume 精简版,设计文档 §1
 * "guest preload | 精简版:alert/confirm 劫持 + wheel 边界转发(无 annotation/webmcp)"):
 *  1. alert/confirm 劫持 → ipcRenderer.sendSync("lume:embedded-browser-javascript-dialog",
 *     {type,message});主进程 EmbeddedBrowserJavaScriptDialogController 以原生对话框应答
 *     (handled:false 回落原生行为)。
 *  2. 捕获阶段 wheel 监听:沿 composedPath 计算每个滚动容器未能消费的剩余 delta
 *     (line=40px、page=innerSize、死区 0.01、钳制 ±10000)→ sendToHost(
 *     "lume:browser-wheel-boundary",{deltaX,deltaY});host renderer 监听 webview 的
 *     `ipc-message` 对面板画布 scrollBy 续接("页面滚到底继续滚面板")。
 *
 * 来源:.zcode/analysis/zcode-browser-panel-architecture.md §4.5/§12(行为规格)。
 *
 * 语义偏差(该文件未进入 extracted/,以架构文档行为规格为准):
 *   1. ZCode 用 `contextBridge.executeInMainWorld`(Electron ≥38 私有面)注入主世界;
 *      Lume(Electron 42)用公开的 `webFrame.executeJavaScript` + contextBridge 桥,
 *      行为等价(主世界 alert/confirm 被替换,sendSync 经桥同步回到 preload)。
 *   2. iframe 递归注入:preload 侧对 frame 树(webFrame 链)一次性注入;同源子 frame
 *      由主世界脚本的 load 捕获监听 + MutationObserver 续装(跨源帧仅覆盖 frame 树
 *      遍历可达部分)—— 精简实现,ZCode 完整语义以原文件为准。
 *   3. wheel 边界通道名 `zcode:embedded-browser-wheel-boundary` → `lume:browser-wheel-boundary`;
 *      对话框通道 `zcode:embedded-browser-javascript-dialog` → `lume:embedded-browser-javascript-dialog`。
 */

/** guest preload → main 的 sendSync 对话框通道(与 ipc.ts BROWSER_EMBEDDED_DIALOG_CHANNEL 一致)。 */
export const GUEST_PRELOAD_DIALOG_CHANNEL = "lume:embedded-browser-javascript-dialog"

/** guest → host 的滚轮边界转发通道(renderer 侧 useBrowserPanel 按 webview ipc-message 匹配)。 */
export const GUEST_PRELOAD_WHEEL_CHANNEL = "lume:browser-wheel-boundary"

/** wheel delta 归一化常量:1 行 = 40px(ZCode line=40px)。 */
const LINE_DELTA_PX = 40
/** wheel delta 死区:|delta| < 0.01 视为无剩余(ZCode 死区 0.01)。 */
const WHEEL_DEAD_ZONE = 0.01
/** wheel delta 钳制 ±10000(ZCode 钳制 ±10000)。 */
const WHEEL_DELTA_CLAMP = 10000

/**
 * 注入到每帧主世界的对话框劫持脚本(自幂等)。
 * 经 contextBridge 暴露的 `__lumeEmbeddedBrowserDialog.report(type, message)` 同步
 * 调回 preload(contextBridge 同步函数 + sendSync 阻塞);同源子 frame 在 load 捕获
 * 与 MutationObserver 触发时经 `patchWindowLike` 原位劫持。
 */
const GUEST_DIALOG_MAIN_WORLD_SCRIPT = String.raw`
(function () {
  'use strict';
  if (window.__lumeBrowserDialogPatched) return;
  var bridge = window.__lumeEmbeddedBrowserDialog;
  if (!bridge || typeof bridge.report !== 'function') return;
  var nativeAlert = window.alert;
  var nativeConfirm = window.confirm;
  window.__lumeBrowserDialogPatched = true;
  window.alert = function (message) {
    var result = bridge.report('alert', String(message == null ? '' : message));
    if ((!result || result.handled !== true) && typeof nativeAlert === 'function') {
      nativeAlert.call(window, message);
    }
  };
  window.confirm = function (message) {
    var result = bridge.report('confirm', String(message == null ? '' : message));
    if (!result || result.handled !== true) {
      if (typeof nativeConfirm === 'function') return nativeConfirm.call(window, message);
      return false;
    }
    return result.value === true;
  };
  function sameOrigin(childWindow) {
    try { return childWindow && childWindow.location != null && childWindow.location.origin === window.location.origin; } catch (error) { return false; }
  }
  function patchWindowLike(targetWindow, targetBridge) {
    if (!sameOrigin(targetWindow) || targetWindow.__lumeBrowserDialogPatched) return;
    var tNativeAlert = targetWindow.alert;
    var tNativeConfirm = targetWindow.confirm;
    try { targetWindow.__lumeBrowserDialogPatched = true; } catch (error) { return; }
    targetWindow.alert = function (message) {
      var result = targetBridge.report('alert', String(message == null ? '' : message));
      if ((!result || result.handled !== true) && typeof tNativeAlert === 'function') {
        tNativeAlert.call(targetWindow, message);
      }
    };
    targetWindow.confirm = function (message) {
      var result = targetBridge.report('confirm', String(message == null ? '' : message));
      if (!result || result.handled !== true) {
        if (typeof tNativeConfirm === 'function') return tNativeConfirm.call(targetWindow, message);
        return false;
      }
      return result.value === true;
    };
  }
  function installIntoFrameElement(frameElement) {
    var attach = function () {
      var childWindow = null;
      try { childWindow = frameElement.contentWindow || null; } catch (error) { childWindow = null; }
      if (sameOrigin(childWindow)) patchWindowLike(childWindow, bridge);
    };
    frameElement.addEventListener('load', attach, true);
    attach();
  }
  function scanFrames() {
    var frames;
    try { frames = document.querySelectorAll('iframe, frame'); } catch (error) { return; }
    for (var index = 0; index < frames.length; index += 1) installIntoFrameElement(frames[index]);
  }
  scanFrames();
  if (typeof MutationObserver === 'function' && document.documentElement) {
    var observer = new MutationObserver(function () { scanFrames(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  document.addEventListener('load', function (event) {
    var target = event.target;
    if (target && (target.tagName === 'IFRAME' || target.tagName === 'FRAME')) installIntoFrameElement(target);
  }, true);
})();
`

/** 完整 guest preload 源码(CommonJS;sandbox preload 可用面:ipcRenderer/webFrame/contextBridge)。 */
export const GUEST_PRELOAD_SOURCE = `"use strict";
var ipcRenderer = require("electron").ipcRenderer;
var webFrame = require("electron").webFrame;
var contextBridge = require("electron").contextBridge;

/* 1. alert/confirm 劫持:contextBridge 桥 + 主世界注入(webFrame 递归)。 */
contextBridge.exposeInMainWorld("__lumeEmbeddedBrowserDialog", {
  report: function (type, message) {
    try {
      return ipcRenderer.sendSync(${JSON.stringify(GUEST_PRELOAD_DIALOG_CHANNEL)}, { type: type, message: String(message == null ? "" : message) });
    } catch (error) {
      return { handled: false };
    }
  },
});

function injectDialogPatch(frame) {
  if (!frame || typeof frame.executeJavaScript !== "function") return;
  try {
    frame.executeJavaScript(${JSON.stringify(GUEST_DIALOG_MAIN_WORLD_SCRIPT)}, false).catch(function () {});
  } catch (error) {}
}
function injectFrameTree(frame) {
  injectDialogPatch(frame);
  var child = frame.firstChild;
  while (child) {
    injectFrameTree(child);
    child = child.nextSibling;
  }
}
injectFrameTree(webFrame);

/* 2. wheel 边界转发:捕获阶段沿 composedPath 计算未被页面消费的剩余 delta。 */
(function () {
  var LINE_DELTA_PX = ${LINE_DELTA_PX};
  var DEAD_ZONE = ${WHEEL_DEAD_ZONE};
  var DELTA_CLAMP = ${WHEEL_DELTA_CLAMP};
  function normalizeWheelDelta(event) {
    var deltaX = event.deltaX || 0;
    var deltaY = event.deltaY || 0;
    if (event.deltaMode === 1) {
      deltaX *= LINE_DELTA_PX;
      deltaY *= LINE_DELTA_PX;
    } else if (event.deltaMode === 2) {
      deltaX *= window.innerWidth || 1;
      deltaY *= window.innerHeight || 1;
    }
    return { deltaX: deltaX, deltaY: deltaY };
  }
  function isScrollableOverflow(value) {
    return value === "auto" || value === "scroll" || value === "overlay";
  }
  function canConsumeDelta(element, axis, delta) {
    if (delta === 0) return false;
    var style = window.getComputedStyle(element);
    var overflow = axis === "x" ? style.overflowX : style.overflowY;
    if (!isScrollableOverflow(overflow)) return false;
    if (axis === "x") {
      if (element.clientWidth >= element.scrollWidth) return false;
      if (delta > 0) return element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      return element.scrollLeft > 1;
    }
    if (element.clientHeight >= element.scrollHeight) return false;
    if (delta > 0) return element.scrollTop + element.clientHeight < element.scrollHeight - 1;
    return element.scrollTop > 1;
  }
  window.addEventListener("wheel", function (event) {
    var normalized = normalizeWheelDelta(event);
    var deltaX = normalized.deltaX;
    var deltaY = normalized.deltaY;
    if (deltaX === 0 && deltaY === 0) return;
    var path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (var index = 0; index < path.length; index += 1) {
      var entry = path[index];
      if (!(entry instanceof Element)) continue;
      if (deltaY !== 0 && canConsumeDelta(entry, "y", deltaY)) deltaY = 0;
      if (deltaX !== 0 && canConsumeDelta(entry, "x", deltaX)) deltaX = 0;
      if (deltaX === 0 && deltaY === 0) return;
    }
    if (Math.abs(deltaX) < DEAD_ZONE) deltaX = 0;
    if (Math.abs(deltaY) < DEAD_ZONE) deltaY = 0;
    if (deltaX === 0 && deltaY === 0) return;
    deltaX = Math.min(DELTA_CLAMP, Math.max(-DELTA_CLAMP, deltaX));
    deltaY = Math.min(DELTA_CLAMP, Math.max(-DELTA_CLAMP, deltaY));
    ipcRenderer.sendToHost(${JSON.stringify(GUEST_PRELOAD_WHEEL_CHANNEL)}, { deltaX: deltaX, deltaY: deltaY });
  }, { capture: true, passive: true });
})();
`

const DEFAULT_PORT = 18792;
const BADGE = {
  on: { text: "ON", color: "#6366F1" },
  off: { text: "", color: "#000000" },
  connecting: { text: "…", color: "#F59E0B" },
  error: { text: "!", color: "#B91C1C" },
};

let relayWs = null;
let relayConnectPromise = null;
let debuggerListenersInstalled = false;
let openOptionsOnAuthErrorOnce = false;
let lastErrorMessage = "";
let reconnectTimer = null;
let reconnectAttempts = 0;

const tabs = new Map();
const tabBySession = new Map();
const tabByTarget = new Map();
const pending = new Map();
let initPromise = null;

async function getRelayPort() {
  const stored = await chrome.storage.local.get(["relayPort"]);
  const n = Number.parseInt(String(stored.relayPort || ""), 10);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? n : DEFAULT_PORT;
}

async function getRelayToken() {
  const stored = await chrome.storage.local.get(["relayToken"]);
  const token = typeof stored.relayToken === "string" ? stored.relayToken.trim() : "";
  return token || null;
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind];
  chrome.action.setBadgeText({ tabId, text: cfg.text });
  chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color });
  const titleByKind = {
    on: "Lume Relay: 已连接当前标签页",
    off: "Lume Relay: 当前标签页未连接",
    connecting: "Lume Relay: 正在连接...",
    error: "Lume Relay: 连接失败"
  };
  chrome.action.setTitle({ tabId, title: titleByKind[kind] || "Lume Relay" }).catch(() => {});
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

async function persistState() {
  try {
    const persistedTabs = [];
    for (const [tabId, info] of tabs.entries()) {
      if (!info?.sessionId) continue;
      persistedTabs.push({
        tabId,
        sessionId: info.sessionId,
        targetId: info.targetId || ""
      });
    }
    await chrome.storage.session.set({ persistedTabs });
  } catch {
    // storage.session 在某些上下文不可用，忽略持久化失败。
  }
}

async function rehydrateState() {
  try {
    const stored = await chrome.storage.session.get(["persistedTabs"]);
    const persistedTabs = Array.isArray(stored.persistedTabs) ? stored.persistedTabs : [];
    for (const entry of persistedTabs) {
      const tabId = Number(entry?.tabId);
      if (!Number.isFinite(tabId)) continue;
      const sessionId = typeof entry?.sessionId === "string" ? entry.sessionId : "";
      const targetId = typeof entry?.targetId === "string" ? entry.targetId : "";
      if (!sessionId) continue;
      tabs.set(tabId, { sessionId, targetId });
      tabBySession.set(sessionId, tabId);
      if (targetId) tabByTarget.set(targetId, tabId);
      setBadge(tabId, "connecting");
    }
  } catch {
    // ignore
  }
}

async function initializeExtensionState() {
  await rehydrateState();
  if (tabs.size > 0) {
    try {
      await ensureRelayConnection();
      await syncAttachedTabsToRelay();
      lastErrorMessage = "";
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : String(error);
      scheduleReconnect();
    }
  }
}

async function whenReady(fn) {
  await initPromise;
  return await fn();
}

function scheduleReconnect() {
  if (relayWs?.readyState === WebSocket.OPEN) return;
  if (relayConnectPromise) return;
  if (reconnectTimer) return;
  if (tabs.size === 0) return;

  const delayMs = Math.min(5000, 400 + reconnectAttempts * 400);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempts += 1;
    void ensureRelayConnection()
      .then(() => {
        reconnectAttempts = 0;
        lastErrorMessage = "";
      })
      .catch((error) => {
        lastErrorMessage = error instanceof Error ? error.message : String(error);
        scheduleReconnect();
      });
  }, delayMs);
}

async function ensureRelayConnection() {
  if (relayWs?.readyState === WebSocket.OPEN) return;
  if (relayConnectPromise) return await relayConnectPromise;
  clearReconnectTimer();

  relayConnectPromise = (async () => {
    const port = await getRelayPort();
    const token = await getRelayToken();
    const wsUrl = token
      ? `ws://127.0.0.1:${port}/extension?token=${encodeURIComponent(token)}`
      : `ws://127.0.0.1:${port}/extension`;

    const ws = new WebSocket(wsUrl);
    relayWs = ws;

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WebSocket timeout")), 5000);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error("WebSocket failed")); };
      ws.onclose = (ev) => { clearTimeout(t); reject(new Error(`Closed: ${ev.code}`)); };
    });

    ws.onmessage = (e) => onRelayMessage(String(e.data || ""));
    ws.onclose = () => onRelayClosed();
    ws.onerror = () => onRelayClosed();
    await syncAttachedTabsToRelay();

    if (!debuggerListenersInstalled) {
      debuggerListenersInstalled = true;
      chrome.debugger.onEvent.addListener(onDebuggerEvent);
      chrome.debugger.onDetach.addListener(onDebuggerDetach);
    }
  })();

  try { await relayConnectPromise; }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastErrorMessage = message;
    if (!openOptionsOnAuthErrorOnce && message.includes("Closed: 1008")) {
      openOptionsOnAuthErrorOnce = true;
      try { await chrome.runtime.openOptionsPage(); } catch {}
    }
    throw error;
  } finally { relayConnectPromise = null; }
}

function onRelayClosed() {
  relayWs = null;
  lastErrorMessage = "Relay disconnected";
  for (const [, p] of pending) p.reject(new Error("Relay disconnected"));
  pending.clear();
  // 不主动 detach，等待重连后重新上报已附加标签页。
  for (const tabId of tabs.keys()) {
    setBadge(tabId, "connecting");
  }
  scheduleReconnect();
}

function sendToRelay(payload) {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) throw new Error("Not connected");
  relayWs.send(JSON.stringify(payload));
}

async function syncAttachedTabsToRelay() {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return;
  const entries = [...tabs.entries()];
  for (const [tabId, info] of entries) {
    try {
      const tab = await chrome.tabs.get(tabId);
      sendToRelay({
        method: "tabAttached",
        params: { sessionId: info.sessionId, targetId: info.targetId, tabId, url: tab.url, title: tab.title }
      });
      setBadge(tabId, "on");
    } catch {
      if (info?.targetId) tabByTarget.delete(info.targetId);
      tabs.delete(tabId);
      if (info?.sessionId) tabBySession.delete(info.sessionId);
      setBadge(tabId, "off");
    }
  }
  await persistState();
}

async function onRelayMessage(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }

  if (msg?.method === "ping") {
    try { sendToRelay({ method: "pong" }); } catch {}
    return;
  }

  if (typeof msg?.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(String(msg.error))) : p.resolve(msg.result);
    }
    return;
  }

  if (typeof msg?.id === "number" && msg.method === "forwardCDPCommand") {
    try {
      const result = await handleForwardCdpCommand(msg);
      sendToRelay({ id: msg.id, result });
    } catch (err) {
      sendToRelay({ id: msg.id, error: err.message });
    }
  }
}

async function handleForwardCdpCommand(msg) {
  const { method, params, sessionId } = msg.params || {};
  const targetId = typeof params?.targetId === "string" ? params.targetId : undefined;

  if (method === "Target.createTarget") {
    const url = typeof params?.url === "string" ? params.url : "about:blank";
    const tab = await chrome.tabs.create({ url, active: false });
    if (typeof tab.id !== "number") throw new Error("Failed to create tab");
    const attached = await attachTab(tab.id);
    return { targetId: attached.targetId || targetId || `tab-${tab.id}` };
  }

  if (method === "Target.activateTarget") {
    const toActivate = targetId ? tabByTarget.get(targetId) : (sessionId ? tabBySession.get(sessionId) : [...tabs.keys()][0]);
    if (!toActivate) return {};
    const tab = await chrome.tabs.get(toActivate).catch(() => null);
    if (!tab) return {};
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    await chrome.tabs.update(toActivate, { active: true }).catch(() => {});
    return {};
  }

  if (method === "Target.closeTarget") {
    const toClose = targetId ? tabByTarget.get(targetId) : (sessionId ? tabBySession.get(sessionId) : [...tabs.keys()][0]);
    if (!toClose) return { success: false };
    await chrome.tabs.remove(toClose).catch(() => {});
    return { success: true };
  }

  const tabId = sessionId
    ? tabBySession.get(sessionId)
    : (targetId ? tabByTarget.get(targetId) : [...tabs.keys()][0]);
  if (!tabId) throw new Error("No attached tab");
  return await chrome.debugger.sendCommand({ tabId }, method, params || {});
}

function isAlreadyDebuggerAttachedError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes("Another debugger is already attached");
}

async function canUseDebuggerOnTab(tabId) {
  try {
    await chrome.debugger.sendCommand({ tabId }, "Target.getTargetInfo");
    return true;
  } catch {
    return false;
  }
}

async function ensureDebuggerAttached(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    return;
  } catch (error) {
    if (!isAlreadyDebuggerAttachedError(error)) {
      throw error;
    }
    // 可能是本扩展已附加（service worker 重启后本地状态丢失）；若能直接发 CDP 命令则复用。
    if (await canUseDebuggerOnTab(tabId)) {
      return;
    }
    throw new Error("当前标签页已被其他调试器占用，请先关闭 DevTools 或其它浏览器自动化扩展后重试。");
  }
}

function onDebuggerEvent(source, method, params) {
  const info = tabs.get(source.tabId);
  if (!info?.sessionId) return;
  try {
    sendToRelay({ method: "forwardCDPEvent", params: { method, params, sessionId: info.sessionId } });
  } catch {}
}

function onDebuggerDetach(source) {
  const info = tabs.get(source.tabId);
  if (info?.targetId) tabByTarget.delete(info.targetId);
  if (info?.sessionId) tabBySession.delete(info.sessionId);
  tabs.delete(source.tabId);
  setBadge(source.tabId, "off");
  void persistState();
}

async function attachTab(tabId) {
  setBadge(tabId, "connecting");
  await ensureRelayConnection();
  await ensureDebuggerAttached(tabId);
  const sessionId = `tab-${tabId}-${Date.now()}`;
  let targetId = "";
  try {
    const info = await chrome.debugger.sendCommand({ tabId }, "Target.getTargetInfo");
    targetId = String(info?.targetInfo?.targetId || "");
  } catch {}
  tabs.set(tabId, { sessionId, targetId });
  tabBySession.set(sessionId, tabId);
  if (targetId) tabByTarget.set(targetId, tabId);

  const tab = await chrome.tabs.get(tabId);
  try {
    sendToRelay({
      method: "tabAttached",
      params: { sessionId, targetId, tabId, url: tab.url, title: tab.title }
    });
  } catch (error) {
    // relay 可能在 attach 期间短暂断开，重连一次后再发 tabAttached。
    await ensureRelayConnection();
    sendToRelay({
      method: "tabAttached",
      params: { sessionId, targetId, tabId, url: tab.url, title: tab.title }
    });
    console.warn("Lume relay reconnect for tabAttached:", error);
  }
  setBadge(tabId, "on");
  lastErrorMessage = "";
  reconnectAttempts = 0;
  clearReconnectTimer();
  await persistState();
  return { sessionId, targetId };
}

async function detachTab(tabId) {
  const info = tabs.get(tabId);
  if (info?.sessionId) {
    try { sendToRelay({ method: "tabDetached", params: { sessionId: info.sessionId } }); } catch {}
    tabBySession.delete(info.sessionId);
  }
  if (info?.targetId) tabByTarget.delete(info.targetId);
  tabs.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  setBadge(tabId, "off");
  await persistState();
  if (tabs.size === 0) {
    reconnectAttempts = 0;
    clearReconnectTimer();
  }
}

chrome.action.onClicked.addListener((tab) => {
  void whenReady(async () => {
    if (typeof tab?.id !== "number") return;
    const tabId = tab.id;
    try {
      if (tabs.has(tabId)) {
        await detachTab(tabId);
      } else {
        await attachTab(tabId);
      }
    } catch (err) {
      setBadge(tabId, "error");
      lastErrorMessage = err instanceof Error ? err.message : String(err);
      console.error("Lume relay error:", err);
    }
  });
});

function getRelayStatus(tabId) {
  return {
    relayConnected: relayWs?.readyState === WebSocket.OPEN,
    tabConnected: tabs.has(tabId),
    tabCount: tabs.size,
    lastErrorMessage
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "relay:get-status") {
    const tabId = Number(message.tabId);
    if (!Number.isFinite(tabId)) {
      sendResponse({ ok: false, error: "tabId 无效" });
      return;
    }
    sendResponse({ ok: true, ...getRelayStatus(tabId) });
    return;
  }

  if (message.type === "relay:toggle-tab") {
    const tabId = Number(message.tabId);
    if (!Number.isFinite(tabId)) {
      sendResponse({ ok: false, error: "tabId 无效" });
      return;
    }
    void whenReady(async () => {
      try {
        if (tabs.has(tabId)) {
          await detachTab(tabId);
        } else {
          await attachTab(tabId);
        }
        sendResponse({ ok: true, ...getRelayStatus(tabId) });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        lastErrorMessage = messageText;
        setBadge(tabId, "error");
        sendResponse({ ok: false, error: messageText, ...getRelayStatus(tabId) });
      }
    });
    return true;
  }

  if (message.type === "relay:open-options") {
    void chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void whenReady(async () => {
    const info = tabs.get(tabId);
    if (!info) return;
    if (info.sessionId) tabBySession.delete(info.sessionId);
    if (info.targetId) tabByTarget.delete(info.targetId);
    tabs.delete(tabId);
    await persistState();
  });
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void whenReady(async () => {
    const info = tabs.get(removedTabId);
    if (!info) return;
    tabs.delete(removedTabId);
    tabs.set(addedTabId, info);
    if (info.sessionId) tabBySession.set(info.sessionId, addedTabId);
    if (info.targetId) tabByTarget.set(info.targetId, addedTabId);
    setBadge(addedTabId, relayWs?.readyState === WebSocket.OPEN ? "on" : "connecting");
    await persistState();
  });
});

chrome.alarms.create("relay-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "relay-keepalive") return;
  void whenReady(async () => {
    if (tabs.size === 0) return;
    if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
      try {
        await ensureRelayConnection();
      } catch {
        scheduleReconnect();
      }
    }
  });
});

initPromise = initializeExtensionState();

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

const tabs = new Map();
const tabBySession = new Map();
const pending = new Map();

async function getRelayPort() {
  const stored = await chrome.storage.local.get(["relayPort"]);
  const n = Number.parseInt(String(stored.relayPort || ""), 10);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? n : DEFAULT_PORT;
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind];
  chrome.action.setBadgeText({ tabId, text: cfg.text });
  chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color });
}

async function ensureRelayConnection() {
  if (relayWs?.readyState === WebSocket.OPEN) return;
  if (relayConnectPromise) return await relayConnectPromise;

  relayConnectPromise = (async () => {
    const port = await getRelayPort();
    const wsUrl = `ws://127.0.0.1:${port}/extension`;

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

    if (!debuggerListenersInstalled) {
      debuggerListenersInstalled = true;
      chrome.debugger.onEvent.addListener(onDebuggerEvent);
      chrome.debugger.onDetach.addListener(onDebuggerDetach);
    }
  })();

  try { await relayConnectPromise; }
  finally { relayConnectPromise = null; }
}

function onRelayClosed() {
  relayWs = null;
  for (const [, p] of pending) p.reject(new Error("Relay disconnected"));
  pending.clear();
  for (const tabId of tabs.keys()) {
    chrome.debugger.detach({ tabId }).catch(() => {});
    setBadge(tabId, "off");
  }
  tabs.clear();
  tabBySession.clear();
}

function sendToRelay(payload) {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) throw new Error("Not connected");
  relayWs.send(JSON.stringify(payload));
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
  const tabId = sessionId ? tabBySession.get(sessionId) : [...tabs.keys()][0];
  if (!tabId) throw new Error("No attached tab");
  return await chrome.debugger.sendCommand({ tabId }, method, params || {});
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
  if (info?.sessionId) tabBySession.delete(info.sessionId);
  tabs.delete(source.tabId);
  setBadge(source.tabId, "off");
}

async function attachTab(tabId) {
  setBadge(tabId, "connecting");
  await ensureRelayConnection();
  await chrome.debugger.attach({ tabId }, "1.3");
  const sessionId = `tab-${tabId}-${Date.now()}`;
  tabs.set(tabId, { sessionId });
  tabBySession.set(sessionId, tabId);

  const tab = await chrome.tabs.get(tabId);
  sendToRelay({
    method: "tabAttached",
    params: { sessionId, tabId, url: tab.url, title: tab.title }
  });
  setBadge(tabId, "on");
}

async function detachTab(tabId) {
  const info = tabs.get(tabId);
  if (info?.sessionId) {
    try { sendToRelay({ method: "tabDetached", params: { sessionId: info.sessionId } }); } catch {}
    tabBySession.delete(info.sessionId);
  }
  tabs.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  setBadge(tabId, "off");
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (tabs.has(tab.id)) {
      await detachTab(tab.id);
    } else {
      await attachTab(tab.id);
    }
  } catch (err) {
    setBadge(tab.id, "error");
    console.error("Lume relay error:", err);
  }
});

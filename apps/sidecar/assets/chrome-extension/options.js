const DEFAULT_PORT = 18792;

function clampPort(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PORT;
  if (parsed <= 0 || parsed > 65535) return DEFAULT_PORT;
  return parsed;
}

function relayUrl(port) {
  return `http://127.0.0.1:${port}/`;
}

function setStatus(kind, text) {
  const node = document.getElementById("status");
  node.textContent = text || "";
  node.style.color = kind === "ok" ? "#166534" : kind === "error" ? "#991b1b" : "#374151";
}

async function checkRelay(port, token) {
  const url = relayUrl(port);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1200);
  try {
    const response = await fetch(url, { method: "HEAD", signal: ctrl.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let tokenRequired = false;
    let relayConnected = null;
    let connectionCount = 0;
    try {
      const statusRes = await fetch(`${url}extension/status`, { signal: ctrl.signal });
      if (statusRes.ok) {
        const status = await statusRes.json();
        tokenRequired = status?.tokenRequired === true;
        relayConnected = status?.connected === true;
        connectionCount = Number(status?.connectionCount || 0);
      }
    } catch {
      // 忽略状态接口失败，保留基本探活结果。
    }
    if (tokenRequired && !token) {
      setStatus("error", `Relay 需要 token，请在下方填写 Relay Token 后保存`);
      return;
    }
    if (relayConnected === true) {
      setStatus("ok", `连接正常：${url}（已连接扩展 ${connectionCount} 个）`);
      return;
    }
    if (relayConnected === false) {
      setStatus("hint", `Relay 可访问：${url}（扩展 WebSocket 尚未连接）`);
      return;
    }
    setStatus("ok", `Relay 可访问：${url}`);
  } catch {
    setStatus("error", `连接失败：${url}，请先启动 Lume sidecar relay`);
  } finally {
    clearTimeout(timer);
  }
}

function updateRelayUrl(port) {
  document.getElementById("relay-url").textContent = relayUrl(port);
}

async function load() {
  const stored = await chrome.storage.local.get(["relayPort", "relayToken"]);
  const port = clampPort(stored.relayPort);
  const token = typeof stored.relayToken === "string" ? stored.relayToken.trim() : "";
  document.getElementById("port").value = String(port);
  document.getElementById("token").value = token;
  updateRelayUrl(port);
  await checkRelay(port, token);
}

async function save() {
  const port = clampPort(document.getElementById("port").value);
  const tokenInput = document.getElementById("token").value.trim();
  await chrome.storage.local.set({ relayPort: port });
  await chrome.storage.local.set({ relayToken: tokenInput });
  document.getElementById("port").value = String(port);
  document.getElementById("token").value = tokenInput;
  updateRelayUrl(port);
  await checkRelay(port, tokenInput);
}

document.getElementById("save").onclick = () => {
  void save();
};

void load();

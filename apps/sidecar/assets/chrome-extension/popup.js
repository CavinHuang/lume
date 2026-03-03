async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || typeof tab.id !== "number") {
    throw new Error("未找到当前标签页");
  }
  return tab.id;
}

let connecting = false;

function setError(message) {
  const node = document.getElementById("error");
  if (!message) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  node.hidden = false;
  node.textContent = message;
}

function setRetry(message) {
  const node = document.getElementById("retry");
  if (!message) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  node.hidden = false;
  node.textContent = message;
}

function renderStatus(status) {
  const state = document.getElementById("state");
  const toggle = document.getElementById("toggle");
  state.textContent = [
    `Relay: ${status.relayConnected ? "已连接" : "未连接"}`,
    `当前标签页: ${status.tabConnected ? "已连接" : "未连接"}`,
    `已连接标签页数量: ${status.tabCount ?? 0}`,
  ].join("\n");
  toggle.textContent = status.tabConnected ? "断开当前标签页" : "连接当前标签页";
  if (status.lastErrorMessage) {
    setError(`最近错误：${status.lastErrorMessage}`);
  } else {
    setError("");
  }
}

async function loadStatus() {
  const tabId = await getActiveTabId();
  const result = await chrome.runtime.sendMessage({ type: "relay:get-status", tabId });
  if (!result?.ok) {
    throw new Error(result?.error || "读取状态失败");
  }
  renderStatus(result);
}

async function toggleCurrentTab() {
  const tabId = await getActiveTabId();
  const result = await chrome.runtime.sendMessage({ type: "relay:toggle-tab", tabId });
  if (!result?.ok) {
    throw new Error(result?.error || "切换连接失败");
  }
  renderStatus(result);
}

async function connectWithRetry(maxAttempts = 5) {
  connecting = true;
  setError("");
  for (let i = 1; i <= maxAttempts; i += 1) {
    setRetry(`连接中... 第 ${i}/${maxAttempts} 次尝试`);
    try {
      await toggleCurrentTab();
      setRetry("");
      connecting = false;
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isRetryable = (
        message.includes("WebSocket")
        || message.includes("Not connected")
        || message.includes("Relay")
        || message.includes("No attached tab")
        || message.includes("Closed:")
      );
      if (!isRetryable || i === maxAttempts) {
        setRetry("");
        connecting = false;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  }
  connecting = false;
}

document.getElementById("toggle").addEventListener("click", () => {
  if (connecting) return;
  void connectWithRetry().catch((error) => {
    setError(error instanceof Error ? error.message : String(error));
  });
});

document.getElementById("refresh").addEventListener("click", () => {
  if (connecting) return;
  void loadStatus().catch((error) => {
    setError(error instanceof Error ? error.message : String(error));
  });
});

document.getElementById("options").addEventListener("click", () => {
  void chrome.runtime.sendMessage({ type: "relay:open-options" });
});

void loadStatus().catch((error) => {
  setError(error instanceof Error ? error.message : String(error));
});

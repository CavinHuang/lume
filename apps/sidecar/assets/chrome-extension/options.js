document.getElementById("save").onclick = async () => {
  const port = parseInt(document.getElementById("port").value, 10);
  if (port > 0 && port <= 65535) {
    await chrome.storage.local.set({ relayPort: port });
    document.getElementById("status").textContent = "Saved!";
  }
};
chrome.storage.local.get(["relayPort"]).then(s => {
  if (s.relayPort) document.getElementById("port").value = s.relayPort;
});

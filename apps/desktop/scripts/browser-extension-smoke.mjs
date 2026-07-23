import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { ExternalChromeTransport } from "../../sidecar/src/services/browser/external-chrome-transport.ts"

if (process.platform !== "win32") throw new Error("This installed Chrome smoke currently supports Windows only")

const packagedLume = process.argv.includes("--packaged-lume")
const pluginRoot = resolve(process.argv.slice(2).find((argument) => !argument.startsWith("--")) ?? "")
const chromePath = resolve(process.env.LUME_SMOKE_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
const lumePath = resolve(process.env.LUME_SMOKE_LUME_PATH ?? join(import.meta.dirname, "..", "dist-unpacked", "win-unpacked", "Lume.exe"))
if (!existsSync(join(pluginRoot, "extension", "manifest.json"))) throw new Error("Pass the absolute lume-chrome plugin root as the first argument")
if (!existsSync(chromePath) || basename(chromePath).toLowerCase() !== "chrome.exe") throw new Error("Chrome executable not found")
if (packagedLume && !existsSync(lumePath)) throw new Error("Packaged Lume executable not found")

const root = mkdtempSync(join(tmpdir(), "lume-installed-browser-smoke-"))
const profile = join(root, "chrome-profile")
const localAppData = join(root, "local-app-data")
const hostDir = join(root, "native-host")
const hostPath = join(hostDir, "lume-chrome-host.exe")
const registryKey = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.lume.browser"
const previousManifest = readRegistryDefault(registryKey)
const pairingId = `smoke-${randomUUID()}`
const pipeEndpoint = `\\\\.\\pipe\\lume-browser-smoke-${randomUUID().replaceAll("-", "")}`
let chrome = null
let transport = null
let fixture = null
let lume = null
let pairingStored = false

try {
  run("node", ["scripts/zip-extension.mjs"], pluginRoot)
  run("cargo", ["build", "--release"], join(pluginRoot, "native-host"))
  mkdirSync(hostDir, { recursive: true })
  copyFileSync(join(pluginRoot, "native-host", "target", "release", "lume-chrome-host.exe"), hostPath)

  const extensionRoot = realpathSync(join(pluginRoot, ".build", "extension"))
  chrome = launchChrome(chromePath, profile, extensionRoot)
  let extensionId
  try {
    extensionId = await waitForExtensionId(profile, extensionRoot, 20_000)
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}${readChromeNativeHostError(profile)}`)
  }
  stopChrome(chrome)
  chrome = null
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))

  run("node", ["scripts/install-native-host.mjs"], pluginRoot, {
    ...process.env,
    LOCALAPPDATA: localAppData,
    LUME_EXTENSION_ID: extensionId,
    LUME_CHROME_HOST_PATH: hostPath,
    LUME_BROWSER_PAIRING_ID: pairingId,
    LUME_BROWSER_PIPE_ENDPOINT: pipeEndpoint,
  })
  pairingStored = true
  const bridge = JSON.parse(readFileSync(join(localAppData, "Lume", "ChromeNativeMessaging", "bridge-config.json"), "utf8"))
  if (packagedLume) {
    const configRoot = join(root, "lume-config")
    mkdirSync(configRoot, { recursive: true })
    writeFileSync(join(configRoot, "settings.json"), JSON.stringify({ browser: { extensionBackendEnabled: true } }))
    writeFileSync(join(configRoot, "lume.yaml"), "version: 1\nplugins:\n  global:\n    enabled:\n      - browser\n      - lume-chrome\n    disabled: []\n")
    lume = launchPackagedLume(lumePath, join(root, "lume-profile"), configRoot, bridge)
  } else {
    transport = new ExternalChromeTransport({
      endpoint: bridge.endpoint,
      pairingId: bridge.pairingId,
      generation: bridge.generation,
      hostPath: bridge.hostPath,
      hostSha256: bridge.hostSha256,
      requestTimeoutMs: 15_000,
    })
    await transport.start()
  }
  chrome = launchChrome(chromePath, profile, extensionRoot)

  if (packagedLume) {
    const backends = await waitForPackagedBrowserBackends(join(root, "lume-profile"), 30_000)
    if (!backends.some((backend) => backend?.backend === "extension")) throw new Error("Packaged Lume did not advertise the connected extension backend")
    console.log(JSON.stringify({ ok: true, packagedLume: true, extensionId, extensionBackend: true }))
  } else {
    fixture = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end("<title>Lume installed smoke</title><label>Name <input id=name></label><button id=apply onclick=\"document.querySelector('output').textContent=document.querySelector('#name').value\">Apply</button><output></output>")
    })
    await new Promise((resolveListen) => fixture.listen(0, "127.0.0.1", resolveListen))
    const address = fixture.address()
    if (!address || typeof address === "string") throw new Error("Fixture server did not bind")
    try {
      await waitUntil(() => transport.isAvailable(), 20_000, "Native Host did not connect through the installed MV3 extension")
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}${readChromeNativeHostError(profile)}: ${JSON.stringify(readExtensionInstallState(profile, extensionId))}`)
    }
    const context = { actor: "agent", browserSessionId: "installed-smoke", browserTurnId: "installed-smoke", capability: "installed-smoke" }
    const request = (method, params = {}) => transport.request({ requestId: randomUUID(), context, method, params })
    const handshake = await request("handshake")
    if (handshake?.protocolVersion !== 5) throw new Error("Installed extension protocol handshake failed")
    const created = await request("ensure", { url: `http://127.0.0.1:${address.port}/` })
    const tabId = created?.tabId
    if (typeof tabId !== "string") throw new Error("Installed extension did not create a leased tab")
    const locator = (selector) => ({ version: 1, steps: [{ kind: "css", selector }] })
    await request("fill", { tabId, locator: locator("#name"), text: "Lume installed bridge" })
    await request("click", { tabId, locator: locator("#apply") })
    const result = await request("locator:innerText", { tabId, locator: locator("output") })
    if (result !== "Lume installed bridge") throw new Error("Installed extension locator input did not roundtrip")
    const screenshot = await request("screenshot", { tabId })
    if (typeof screenshot?.dataBase64 !== "string" || screenshot.dataBase64.length < 100) throw new Error("Installed extension screenshot was empty")
    await request("close", { tabId })
    console.log(JSON.stringify({ ok: true, extensionId, protocolVersion: handshake.protocolVersion, locatorRoundtrip: true, screenshot: true }))
  }
} finally {
  if (transport) await transport.close().catch(() => undefined)
  if (lume) stopChrome(lume)
  if (chrome) stopChrome(chrome)
  if (fixture) await new Promise((resolveClose) => fixture.close(() => resolveClose()))
  if (pairingStored && existsSync(hostPath)) spawnSync(hostPath, ["pairing", "delete", pairingId], { windowsHide: true, stdio: "ignore" })
  restoreRegistryDefault(registryKey, previousManifest)
  await removeTemporaryRoot(root)
}

async function removeTemporaryRoot(target) {
  if (dirname(target) !== tmpdir() || !basename(target).startsWith("lume-installed-browser-smoke-")) {
    throw new Error("Refusing to remove an unexpected browser smoke path")
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 19) throw error
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
    }
  }
}

function launchPackagedLume(executable, userDataDir, configRoot, bridge) {
  mkdirSync(userDataDir, { recursive: true })
  return spawn(executable, [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
  ], {
    env: {
      ...process.env,
      LUME_CONFIG_DIR: configRoot,
      LUME_CHROME_BRIDGE_ENDPOINT: bridge.endpoint,
      LUME_CHROME_BRIDGE_PAIRING_ID: bridge.pairingId,
      LUME_CHROME_BRIDGE_GENERATION: String(bridge.generation),
      LUME_CHROME_BRIDGE_HOST_PATH: bridge.hostPath,
      LUME_CHROME_BRIDGE_HOST_SHA256: bridge.hostSha256,
    },
    stdio: "ignore",
    windowsHide: true,
  })
}

async function waitForPackagedBrowserBackends(userDataDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = ""
  while (Date.now() < deadline) {
    try {
      const port = readFileSync(join(userDataDir, "DevToolsActivePort"), "utf8").split(/\r?\n/, 1)[0]
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
      const page = targets.find((target) => target.type === "page" && typeof target.webSocketDebuggerUrl === "string")
      if (!page) throw new Error("renderer target unavailable")
      const backends = await evaluateCdp(page.webSocketDebuggerUrl, "globalThis.electronAPI.invoke('sidecar_call', { method: 'browser:backends', params: null })")
      if (Array.isArray(backends) && backends.some((backend) => backend?.backend === "extension")) return backends
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150))
  }
  throw new Error(`Packaged Lume did not connect to the extension backend: ${lastError}`)
}

function evaluateCdp(webSocketUrl, expression) {
  return new Promise((resolveValue, reject) => {
    const socket = new WebSocket(webSocketUrl)
    const id = 1
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error("CDP evaluation timed out"))
    }, 5_000)
    socket.onopen = () => socket.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: { expression, awaitPromise: true, returnByValue: true },
    }))
    socket.onerror = () => {
      clearTimeout(timer)
      reject(new Error("CDP connection failed"))
    }
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== id) return
      clearTimeout(timer)
      socket.close()
      if (message.result?.exceptionDetails) return reject(new Error(message.result.exceptionDetails.text ?? "CDP evaluation failed"))
      resolveValue(message.result?.result?.value)
    }
  })
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", windowsHide: true })
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`)
}

function launchChrome(executable, userDataDir, extensionRoot, startUrl = "about:blank") {
  return spawn(executable, [
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${extensionRoot}`,
    `--disable-extensions-except=${extensionRoot}`,
    "--window-position=-10000,-10000",
    "--window-size=800,600",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-component-update",
    "--remote-debugging-port=0",
    "--enable-logging",
    `--log-file=${join(userDataDir, "chrome.log")}`,
    startUrl,
  ], { stdio: "ignore", windowsHide: true })
}

function stopChrome(child) {
  if (!child?.pid) return
  spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
}

async function waitForExtensionId(userDataDir, extensionRoot, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const filename of ["Preferences", "Secure Preferences"]) {
      const preferences = join(userDataDir, "Default", filename)
      if (!existsSync(preferences)) continue
      try {
        const settings = JSON.parse(readFileSync(preferences, "utf8"))?.extensions?.settings ?? {}
        const extensionId = Object.entries(settings).find(([, value]) => {
          try { return realpathSync(value.path).toLowerCase() === extensionRoot.toLowerCase() } catch { return false }
        })?.[0]
        if (typeof extensionId === "string") return extensionId
      } catch {}
    }
    const portFile = join(userDataDir, "DevToolsActivePort")
    if (existsSync(portFile)) {
      try {
        const port = readFileSync(portFile, "utf8").split(/\r?\n/, 1)[0]
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
        const match = targets.map((target) => String(target.url ?? "").match(/^chrome-extension:\/\/([a-p]{32})\/dist\/extension\/background\.js$/)?.[1]).find(Boolean)
        if (match) return match
      } catch {}
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error("Chrome did not load the unpacked Lume extension")
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
}

function readRegistryDefault(key) {
  const result = spawnSync("reg", ["query", key, "/ve"], { encoding: "utf8", windowsHide: true })
  return result.status === 0 ? result.stdout.match(/REG_SZ\s+(.+)\r?$/m)?.[1]?.trim() : undefined
}

function restoreRegistryDefault(key, value) {
  if (value) spawnSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"], { windowsHide: true, stdio: "ignore" })
  else spawnSync("reg", ["delete", key, "/f"], { windowsHide: true, stdio: "ignore" })
}

function readChromeNativeHostError(userDataDir) {
  const logPath = join(userDataDir, "chrome.log")
  if (!existsSync(logPath)) return ""
  const lines = readFileSync(logPath, "utf8").split(/\r?\n/)
    .filter((line) => /native.?messag|com\.lume\.browser|extension/i.test(line))
    .slice(-10)
  return lines.length ? `: ${lines.join(" | ")}` : ""
}

function readExtensionInstallState(userDataDir, extensionId) {
  for (const filename of ["Preferences", "Secure Preferences"]) {
    const preferences = join(userDataDir, "Default", filename)
    if (!existsSync(preferences)) continue
    try {
      const value = JSON.parse(readFileSync(preferences, "utf8"))?.extensions?.settings?.[extensionId]
      if (value) return { filename, state: value.state, location: value.location, path: value.path, disableReasons: value.disable_reasons, manifest: value.manifest }
    } catch {}
  }
  return undefined
}

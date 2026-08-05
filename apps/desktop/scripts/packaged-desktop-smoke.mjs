import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

if (process.platform !== "win32") throw new Error("The packaged desktop smoke currently supports Windows only")

const desktopRoot = resolve(import.meta.dirname, "..")
const defaultExecutable = existsSync(join(desktopRoot, "dist-release", "win-unpacked", "Lume.exe"))
  ? join(desktopRoot, "dist-release", "win-unpacked", "Lume.exe")
  : join(desktopRoot, "dist-unpacked", "win-unpacked", "Lume.exe")
const executable = resolve(process.env.LUME_PACKAGED_EXE ?? defaultExecutable)
if (!existsSync(executable)) throw new Error(`Packaged Lume executable not found: ${executable}`)

const root = mkdtempSync(join(tmpdir(), "lume-packaged-desktop-smoke-"))
const userData = join(root, "user-data")
let child

try {
  child = spawn(executable, [
    `--user-data-dir=${userData}`,
    "--remote-debugging-port=0",
    "--no-first-run",
  ], {
    env: { ...process.env, LUME_CONFIG_DIR: join(root, "config") },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  let stderr = ""
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const portFile = join(userData, "DevToolsActivePort")
  await waitUntil(() => existsSync(portFile), 30_000, () => `Packaged Lume did not expose DevTools: ${stderr.slice(-2_000)}`)
  const port = readFileSync(portFile, "utf8").split(/\r?\n/, 1)[0]
  let target
  await waitUntil(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()).catch(() => [])
    target = targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl)
    return Boolean(target)
  }, 30_000, () => "Packaged Lume did not create a renderer target")
  let renderer
  await waitUntil(async () => {
    renderer = await evaluate(target.webSocketDebuggerUrl, `({
      readyState: document.readyState,
      title: document.title,
      desktopBridge: typeof globalThis.electronAPI === "object"
    })`).catch(() => undefined)
    return renderer?.readyState === "complete" && renderer.desktopBridge === true
  }, 30_000, () => `Packaged Lume renderer did not initialize: ${JSON.stringify(renderer)}`)
  if (renderer?.readyState !== "complete" || !renderer.desktopBridge) {
    throw new Error(`Packaged Lume renderer did not initialize: ${JSON.stringify(renderer)}`)
  }
  const resourcesRoot = join(resolve(executable, ".."), "resources")
  const openConnectorMetadata = join(resourcesRoot, "openconnector", "lume-resource.json")
  if (!existsSync(openConnectorMetadata)) throw new Error("Packaged OpenConnector resource metadata is missing")
  await evaluate(target.webSocketDebuggerUrl, `globalThis.electronAPI.invoke("connection_vault_setup", { password: "packaged-smoke-password" })`)
  const linkRuntime = await evaluate(target.webSocketDebuggerUrl, `globalThis.electronAPI.invoke("link_runtime_enable")`)
  if (linkRuntime?.phase !== "online") throw new Error(`Packaged OpenConnector runtime did not start: ${JSON.stringify(linkRuntime)}`)
  await evaluate(target.webSocketDebuggerUrl, `globalThis.electronAPI.invoke("link_runtime_disable")`)
  console.log(JSON.stringify({ ok: true, renderer: true, sidecarBundle: existsSync(join(resourcesRoot, "sidecar", "index.mjs")), openConnector: JSON.parse(readFileSync(openConnectorMetadata, "utf8")).version, linkRuntime: linkRuntime.phase }))
} finally {
  if (child?.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message())
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
}

function evaluate(webSocketUrl, expression) {
  return new Promise((resolveValue, reject) => {
    const socket = new WebSocket(webSocketUrl)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error("Packaged renderer CDP evaluation timed out"))
    }, 5_000)
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }))
    socket.onerror = () => {
      clearTimeout(timer)
      reject(new Error("Packaged renderer CDP connection failed"))
    }
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== 1) return
      clearTimeout(timer)
      socket.close()
      if (message.result?.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.exception?.description ?? "Packaged renderer evaluation failed"))
        return
      }
      resolveValue(message.result?.result?.value)
    }
  })
}

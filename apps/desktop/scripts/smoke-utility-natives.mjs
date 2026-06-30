import { app, utilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const workerPath = resolve(scriptDir, 'smoke-native-worker.mjs')
const nativePath = process.env.LUME_NATIVES_PATH

if (!nativePath) {
  console.error('[smoke-utility-natives] missing LUME_NATIVES_PATH')
  process.exit(1)
}
if (!existsSync(nativePath)) {
  console.error(`[smoke-utility-natives] missing native binary: ${nativePath}`)
  process.exit(1)
}

let child = null
let settled = false
let timeout = null

function finish(code, message) {
  if (settled) return
  settled = true
  if (timeout) clearTimeout(timeout)
  if (message) console.error(message)
  child?.kill()
  setImmediate(() => app.exit(code))
}

app.whenReady().then(() => {
  child = utilityProcess.fork(workerPath, [], {
    cwd: dirname(workerPath),
    env: process.env,
    serviceName: 'Lume Native Smoke',
    stdio: 'pipe',
  })

  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  child.on('message', (message) => {
    if (typeof message !== 'string') return
    let payload
    try {
      payload = JSON.parse(message)
    } catch {
      return
    }
    if (payload.ok) {
      finish(0, '[smoke-utility-natives] ok')
      return
    }
    finish(1, `[smoke-utility-natives] failed: ${payload.error ?? JSON.stringify(payload)}\n${stderr}`)
  })
  child.once('error', (type, location, report) => {
    finish(1, `[smoke-utility-natives] utility process error: ${type} at ${location}\n${report}\n${stderr}`)
  })
  child.once('exit', (code) => {
    if (!settled) finish(1, `[smoke-utility-natives] native worker exited before result (code=${code})\n${stderr}`)
  })
  timeout = setTimeout(() => {
    finish(1, `[smoke-utility-natives] timed out\n${stderr}`)
  }, 20_000)
}).catch((error) => {
  finish(1, `[smoke-utility-natives] Electron startup failed: ${error.stack ?? error}`)
})

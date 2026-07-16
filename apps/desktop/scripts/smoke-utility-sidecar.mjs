import { app, utilityProcess } from 'electron'
import { Worker } from 'node:worker_threads'
import { dirname } from 'node:path'

const sidecarPath = process.env.LUME_SIDECAR_BUNDLE
const xhrWorkerPath = process.env.LUME_XHR_SYNC_WORKER
if (!sidecarPath || !xhrWorkerPath) {
  console.error('[smoke-utility-sidecar] missing sidecar bundle or XHR worker')
  process.exit(1)
}

let child = null
let xhrWorker = null
let settled = false
let timeout = null
let sidecarHealthy = false
let xhrWorkerHealthy = false

function finish(code, message) {
  if (settled) return
  settled = true
  if (timeout) clearTimeout(timeout)
  if (message) console.error(message)
  child?.kill()
  xhrWorker?.terminate()
  setImmediate(() => app.exit(code))
}

function finishWhenHealthy() {
  if (sidecarHealthy && xhrWorkerHealthy) finish(0, '[smoke-utility-sidecar] sidecar and XHR worker ok')
}

app.whenReady().then(() => {
  xhrWorker = new Worker(xhrWorkerPath)
  xhrWorker.once('error', (error) => {
    finish(1, `[smoke-utility-sidecar] XHR worker failed: ${error.stack ?? error}`)
  })
  xhrWorker.once('exit', (code) => {
    if (settled) return
    if (code !== 0) {
      finish(1, `[smoke-utility-sidecar] XHR worker exited with code ${code}`)
      return
    }
    xhrWorkerHealthy = true
    finishWhenHealthy()
  })

  child = utilityProcess.fork(sidecarPath, [], {
    cwd: dirname(sidecarPath),
    env: process.env,
    serviceName: 'Lume Sidecar Smoke',
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
    if (payload.method === 'system.ready') {
      child.postMessage(JSON.stringify({ id: 1, method: 'healthcheck', params: null }))
      return
    }
    if (payload.id !== 1) return
    if (payload.error) {
      finish(1, `[smoke-utility-sidecar] healthcheck failed: ${JSON.stringify(payload.error)}\n${stderr}`)
      return
    }
    if (payload.result?.ok !== true) {
      finish(1, `[smoke-utility-sidecar] unexpected healthcheck: ${JSON.stringify(payload.result)}\n${stderr}`)
      return
    }
    if (payload.result?.native?.available !== true) {
      finish(1, `[smoke-utility-sidecar] native unavailable: ${JSON.stringify(payload.result)}\n${stderr}`)
      return
    }
    sidecarHealthy = true
    finishWhenHealthy()
  })
  child.once('spawn', () => {
    console.error(`[smoke-utility-sidecar] utility process spawned (pid=${child.pid})`)
  })
  child.once('error', (type, location, report) => {
    finish(1, `[smoke-utility-sidecar] utility process error: ${type} at ${location}\n${report}\n${stderr}`)
  })
  child.once('exit', (code) => {
    if (!settled) finish(1, `[smoke-utility-sidecar] sidecar exited before healthcheck (code=${code})\n${stderr}`)
  })
  timeout = setTimeout(() => {
    finish(1, `[smoke-utility-sidecar] healthcheck timed out\n${stderr}`)
  }, 20_000)
}).catch((error) => {
  finish(1, `[smoke-utility-sidecar] Electron startup failed: ${error.stack ?? error}`)
})

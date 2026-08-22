const runningInElectron = Boolean(process.versions.electron)
const { app, utilityProcess } = runningInElectron
  ? await import('electron')
  : { app: null, utilityProcess: null }
import { spawn } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

if (process.platform === 'win32') app?.commandLine.appendSwitch('no-stdio-init')

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
  xhrWorker?.terminate()
  const childExit = child ? new Promise((resolve) => {
    if (child.exitCode !== null && child.exitCode !== undefined) {
      resolve()
      return
    }
    const forceResolve = setTimeout(resolve, 5_000)
    child.once('exit', () => {
      clearTimeout(forceResolve)
      resolve()
    })
    child.kill()
  }) : Promise.resolve()
  void childExit.then(() => {
    if (app) app.exit(code)
    else process.exit(code)
  })
}

function finishWhenHealthy() {
  if (sidecarHealthy && xhrWorkerHealthy) {
    finish(0, '[smoke-utility-sidecar] sidecar and XHR worker ok')
  }
}

const ready = app ? app.whenReady() : Promise.resolve()
ready.then(() => {
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

  child = spawnSidecar(sidecarPath)

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
    if (payload.method === 'system.log-batch') {
      const batchId = payload.params?.batchId
      if (typeof batchId === 'string') {
        child.postMessage(JSON.stringify({ method: 'system.log-ack', params: { batchId } }))
      }
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
  }, process.platform === 'win32' ? 120_000 : 20_000)
}).catch((error) => {
  finish(1, `[smoke-utility-sidecar] Electron startup failed: ${error.stack ?? error}`)
})

function spawnSidecar(entry) {
  if (process.platform !== 'win32') {
    return utilityProcess.fork(entry, [], {
      cwd: dirname(entry),
      env: process.env,
      serviceName: 'Lume Sidecar Smoke',
      stdio: 'pipe',
    })
  }

  const processChild = spawn(runningInElectron ? 'node' : process.execPath, [
    '-e',
    `import(${JSON.stringify(pathToFileURL(entry).href)}).catch((error) => { console.error(error.stack ?? error); process.exitCode = 1 })`,
  ], {
    cwd: dirname(entry),
    env: {
      ...process.env,
      LUME_SIDECAR_TRANSPORT: 'stdio',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let outputBuffer = ''
  processChild.stdout.on('data', (chunk) => {
    outputBuffer += chunk.toString()
    let newlineIndex
    while ((newlineIndex = outputBuffer.indexOf('\n')) >= 0) {
      const line = outputBuffer.slice(0, newlineIndex).replace(/\r$/, '')
      outputBuffer = outputBuffer.slice(newlineIndex + 1)
      processChild.emit('message', line)
    }
  })
  processChild.postMessage = (message) => processChild.stdin.write(`${message}\n`)
  return processChild
}

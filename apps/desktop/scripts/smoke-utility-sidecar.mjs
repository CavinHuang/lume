import { app, utilityProcess } from 'electron'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { Worker } from 'node:worker_threads'
import { dirname } from 'node:path'

if (process.platform === 'win32') app.commandLine.appendSwitch('no-stdio-init')

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
let wikiRuntimeHealthy = process.platform !== 'win32'
let wikiPollTimer = null
const wikiCredential = randomBytes(32).toString('base64url')
const wikiSmokeTitle = `Wiki release smoke ${Date.now()}`

function finish(code, message) {
  if (settled) return
  settled = true
  if (timeout) clearTimeout(timeout)
  if (wikiPollTimer) clearTimeout(wikiPollTimer)
  if (message) console.error(message)
  child?.kill()
  xhrWorker?.terminate()
  setImmediate(() => app.exit(code))
}

function finishWhenHealthy() {
  if (sidecarHealthy && xhrWorkerHealthy && wikiRuntimeHealthy) {
    finish(0, '[smoke-utility-sidecar] sidecar, XHR worker, and Wiki runtime ok')
  }
}

function pollWikiRuntime() {
  child?.postMessage(JSON.stringify({ id: 3, method: 'wiki:get-capabilities', params: null }))
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
      child.postMessage(JSON.stringify({ method: 'system.wiki-privileged-credential', params: { credential: wikiCredential } }))
      child.postMessage(JSON.stringify({ id: 1, method: 'healthcheck', params: null }))
      return
    }
    if (payload.id === 2) {
      if (payload.error) {
        finish(1, `[smoke-utility-sidecar] Wiki runtime preparation failed: ${JSON.stringify(payload.error)}\n${stderr}`)
        return
      }
      wikiPollTimer = setTimeout(pollWikiRuntime, 250)
      return
    }
    if (payload.id === 3) {
      if (payload.error) {
        finish(1, `[smoke-utility-sidecar] Wiki capability check failed: ${JSON.stringify(payload.error)}\n${stderr}`)
        return
      }
      if (payload.result?.runtimeStatus === 'preparing') {
        wikiPollTimer = setTimeout(pollWikiRuntime, 250)
        return
      }
      if (payload.result?.phase !== 'B' || payload.result?.runtimeStatus !== 'ready') {
        finish(1, `[smoke-utility-sidecar] Wiki runtime unavailable: ${JSON.stringify(payload.result)}\n${stderr}`)
        return
      }
      child.postMessage(JSON.stringify({ id: 4, method: 'wiki:create-import-draft', params: { source: { kind: 'text', title: wikiSmokeTitle, text: 'packaged proposal confirmation search proof' }, title: wikiSmokeTitle, pageType: 'topic', primaryWorkspaceId: null } }))
      return
    }
    if (payload.id === 4) {
      if (payload.error || !payload.result?.draftId || payload.result?.nonce) {
        finish(1, `[smoke-utility-sidecar] Wiki proposal contract failed: ${JSON.stringify(payload)}\n${stderr}`)
        return
      }
      child.postMessage(JSON.stringify({ id: 5, method: 'wiki:privileged-apply-draft', params: { credential: wikiCredential, request: { draftId: payload.result.draftId, expectedRevision: payload.result.revision, diffHash: payload.result.diffHash } } }))
      return
    }
    if (payload.id === 5) {
      if (payload.error || payload.result?.state !== 'committed') {
        finish(1, `[smoke-utility-sidecar] Wiki privileged confirmation failed: ${JSON.stringify(payload)}\n${stderr}`)
        return
      }
      child.postMessage(JSON.stringify({ id: 6, method: 'wiki:search', params: { query: wikiSmokeTitle, scope: { kind: 'all' }, maxResults: 10 } }))
      return
    }
    if (payload.id === 6) {
      if (payload.error || !Array.isArray(payload.result) || !payload.result.some((item) => item?.page?.title === wikiSmokeTitle)) {
        finish(1, `[smoke-utility-sidecar] confirmed Wiki page is not searchable: ${JSON.stringify(payload)}\n${stderr}`)
        return
      }
      wikiRuntimeHealthy = true
      finishWhenHealthy()
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
    if (process.platform === 'win32') {
      child.postMessage(JSON.stringify({ id: 2, method: 'wiki:prepare-runtime', params: null }))
    }
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

  const processChild = spawn('node', [entry], {
    cwd: dirname(entry),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      LUME_SIDECAR_TRANSPORT: 'stdio',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const lines = createInterface({ input: processChild.stdout, crlfDelay: Infinity })
  lines.on('line', (line) => processChild.emit('message', line))
  processChild.postMessage = (message) => processChild.stdin.write(`${message}\n`)
  return processChild
}

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'lume-browser-runtime-e2e-'))
const appRoot = join(root, 'app')
const configRoot = join(root, 'config')
const resultPath = join(root, 'result.json')
mkdirSync(appRoot)
mkdirSync(configRoot)

try {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'browser-runtime.ts')
  const build = await Bun.build({ entrypoints: [source], outdir: appRoot, target: 'node', format: 'esm', external: ['electron'] })
  if (!build.success) throw new Error(build.logs.map(String).join('\n'))
  const builtModule = build.outputs[0]?.path
  if (!builtModule) throw new Error('browser runtime module was not built')
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'lume-browser-runtime-e2e', type: 'module', main: 'main.mjs' }))
  writeFileSync(join(appRoot, 'main.mjs'), electronFixtureMain(builtModule.replace(/\\/g, '/')))

  const child = spawn(findElectronBinary(), [`--user-data-dir=${join(root, 'user-data')}`, appRoot], {
    env: { ...process.env, LUME_BROWSER_E2E_CONFIG: configRoot, LUME_BROWSER_E2E_RESULT: resultPath },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const exitCode = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Electron browser runtime fixture timed out')) }, 45_000)
    child.once('error', reject)
    child.once('exit', code => { clearTimeout(timer); resolveExit(code) })
  })
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null
  if (exitCode !== 0 || !result?.ok) throw new Error(`Electron browser runtime fixture failed\n${stdout}\n${stderr}\n${JSON.stringify(result)}`)
  console.log(`Browser runtime Electron integration passed: ${result.assertions} assertions`)
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

function findElectronBinary() {
  const executable = process.platform === 'win32' ? 'electron.exe' : 'electron'
  const packageRoot = dirname(Bun.resolveSync('electron/package.json', import.meta.dir))
  const local = join(packageRoot, 'dist', executable)
  if (existsSync(local)) return local
  if (process.env.ELECTRON_PATH && existsSync(process.env.ELECTRON_PATH)) return process.env.ELECTRON_PATH
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const worktreesRoot = resolve(repositoryRoot, '..')
  for (const sibling of existsSync(worktreesRoot) ? readdirSync(worktreesRoot) : []) {
    const candidate = join(worktreesRoot, sibling, 'node_modules', '.bun', 'electron@42.5.1', 'node_modules', 'electron', 'dist', executable)
    if (existsSync(candidate)) return candidate
  }
  throw new Error('A real Electron binary is required')
}

function electronFixtureMain(modulePath) {
  return `
import { app, BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserRuntime } from 'file:///${modulePath}'

const resultPath = process.env.LUME_BROWSER_E2E_RESULT
const configRoot = process.env.LUME_BROWSER_E2E_CONFIG
let assertions = 0
const check = (value, message) => { assertions += 1; if (!value) throw new Error(message) }
const waitUntil = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error('timed out waiting for fixture state')
}
const server = createServer((request, response) => {
  if (request.url === '/download') {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="fixture.txt"' })
    response.end('download fixture')
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(\`<!doctype html><meta name="viewport" content="width=device-width"><title>Lume fixture</title>
    <label>Name <input id="name" aria-label="Name"></label>
    <button id="submit" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value">Apply</button>
    <a id="download" href="/download" download="fixture.txt">Download</a>
    <output id="result"></output>\`)
})

app.whenReady().then(async () => {
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const origin = 'http://127.0.0.1:' + server.address().port
  const win = new BrowserWindow({ show: true, x: -10_000, y: -10_000, width: 900, height: 700, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const events = []
  const runtime = new BrowserRuntime({
    getWindow: () => win,
    configDir: () => configRoot,
    emit: event => events.push(event),
    isAgentPluginEnabled: () => true,
    initialSettings: {
      siteOverrides: { [origin]: 'allow' },
      agentCursorVisible: false,
      downloadDirectory: join(configRoot, 'user-downloads'),
      downloadAskBeforeSave: false,
      downloadHistoryEnabled: true,
    },
    journalEncryption: { available: true, encrypt: value => Buffer.from(value) },
    credentialStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
  })
  runtime.setAgentPluginEnabled(true)
  const context = { actor: 'agent', browserSessionId: 'fixture-session', browserTurnId: 'fixture-turn', capability: 'browser' }
  const call = (method, params = {}) => runtime.dispatch({ requestId: crypto.randomUUID(), context, method, params })
  try {
    const handshake = await call('handshake')
    check(handshake.protocolVersion === 5 && handshake.minSupported === 5 && handshake.maxSupported === 5, 'browser protocol handshake drifted from the canonical client')
    const created = await call('ensure', { tabId: 'fixture-tab' })
    check(created.tabId === 'fixture-tab' && created.backend === 'iab', 'logical tab was not created')
    const bounded = await call('bounds', { tabId: 'fixture-tab', x: 20, y: 30, width: 640, height: 480, surface: 'main', visible: true })
    check(bounded.visible && bounded.surface === 'main', 'native view bounds/surface were not applied')
    await call('navigate', { tabId: 'fixture-tab', url: origin + '/' })
    check((await call('url', { tabId: 'fixture-tab' })).startsWith(origin), 'fixture navigation failed')
    const views = win.contentView.children.filter(child => child.webContents)
    check(views.length === 1, 'browser did not create exactly one WebContentsView')
    const view = views[0]
    check(view.getBounds().width === 640 && view.getBounds().height === 480, 'WebContentsView bounds differ from shell bounds')
    const moved = await call('bounds', { tabId: 'fixture-tab', x: 680, y: 30, width: 200, height: 480, surface: 'right-panel', visible: true })
    check(moved.surface === 'right-panel' && win.contentView.children.filter(child => child.webContents)[0] === view, 'surface migration replaced the native WebContentsView')
    check((await call('url', { tabId: 'fixture-tab' })).startsWith(origin), 'surface migration reloaded the page')
    await call('bounds', { tabId: 'fixture-tab', x: 20, y: 30, width: 640, height: 480, surface: 'main', visible: true })
    const contentBounds = win.getContentBounds()
    await call('bounds', { tabId: 'fixture-tab', x: contentBounds.width - 10, y: contentBounds.height - 10, width: 500, height: 500, surface: 'main', visible: true })
    const clippedBounds = view.getBounds()
    check(clippedBounds.width <= 10 && clippedBounds.height <= 10 && clippedBounds.x + clippedBounds.width <= contentBounds.width && clippedBounds.y + clippedBounds.height <= contentBounds.height, 'WebContentsView escaped the BrowserWindow content bounds')
    await call('bounds', { tabId: 'fixture-tab', x: 20, y: 30, width: 640, height: 480, surface: 'main', visible: true })
    const geolocationPermission = await view.webContents.executeJavaScript("new Promise(resolve => navigator.geolocation.getCurrentPosition(() => resolve('allowed'), error => resolve(error.code === 1 ? 'denied' : 'other'), { timeout: 1000 }))")
    check(geolocationPermission === 'denied', 'agent browser session did not deny site permissions')
    const locator = selector => ({ version: 1, steps: [{ kind: 'css', selector }] })
    await call('fill', { tabId: 'fixture-tab', locator: locator('#name'), text: 'Lume Agent' })
    const inputValue = await view.webContents.executeJavaScript("document.querySelector('#name').value")
    check(inputValue === 'Lume Agent', 'locator fill did not update the input: ' + JSON.stringify(inputValue))
    check(await call('locator:inputValue', { tabId: 'fixture-tab', locator: locator('#name') }) === 'Lume Agent', 'locator inputValue did not read the isolated-world DOM')
    check(await call('locator:count', { tabId: 'fixture-tab', locator: locator('button') }) === 1, 'locator count was incorrect')
    await call('locator:waitFor', { tabId: 'fixture-tab', locator: locator('#submit'), state: 'visible', timeoutMs: 1000 })
    await call('wait:url', { tabId: 'fixture-tab', url: origin + '/*', timeoutMs: 1000 })
    await call('click', { tabId: 'fixture-tab', locator: locator('#submit') })
    const pageResult = await view.webContents.executeJavaScript("document.querySelector('#result').textContent")
    check(pageResult === 'Lume Agent', 'locator fill/click did not update the page')
    await view.webContents.executeJavaScript("document.querySelector('#result').textContent = ''")
    await call('press', { tabId: 'fixture-tab', locator: locator('#submit'), key: 'Enter' })
    check(await view.webContents.executeJavaScript("document.querySelector('#result').textContent") === 'Lume Agent', 'locator press did not focus and activate the target')
    const snapshot = await call('snapshot', { tabId: 'fixture-tab' })
    check(Array.isArray(snapshot.documents) && snapshot.documents.length === 1, 'DOM snapshot was not captured')
    const screenshot = await call('screenshot', { tabId: 'fixture-tab' })
    check(typeof screenshot === 'string' && screenshot.length > 100, 'viewport screenshot was empty')
    await call('zoom:set', { tabId: 'fixture-tab', factor: 1.25 })
    check(Math.abs((await call('zoom:get', { tabId: 'fixture-tab' })).factor - 1.25) < 0.01, 'zoom factor did not roundtrip')
    check((await call('emulate', { tabId: 'fixture-tab', preset: 'phone' })).preset === 'phone', 'device emulation failed')
    check((await call('list')).length === 1, 'logical tab list drifted from native views')
    const userContext = { actor: 'user', browserSessionId: 'renderer', browserTurnId: 'renderer' }
    const userCall = (method, params = {}) => runtime.dispatch({ requestId: crypto.randomUUID(), context: userContext, method, params })
    await userCall('ensure', { tabId: 'user-download-tab' })
    await userCall('navigate', { tabId: 'user-download-tab', url: origin + '/' })
    const userView = win.contentView.children.find(child => child.webContents && child !== view)
    await userView.webContents.executeJavaScript("document.querySelector('#download').click()")
    await waitUntil(() => events.some(event => event.method === 'browser:download' && event.params?.state === 'completed' && event.params?.filename === 'fixture.txt'))
    const downloadedPath = join(configRoot, 'user-downloads', 'fixture.txt')
    check(existsSync(downloadedPath) && readFileSync(downloadedPath, 'utf8') === 'download fixture', 'user download was not saved to the configured directory')
    const downloadHistory = await userCall('downloads:list')
    const completedDownload = downloadHistory.find(item => item.filename === 'fixture.txt' && item.actor === 'user' && item.state === 'completed')
    check(Boolean(completedDownload) && !('path' in completedDownload), 'download history leaked a local path or missed the completed item')
    await userCall('close', { tabId: 'user-download-tab' })
    let staleTargetObserved = false
    for (let attempt = 0; attempt < 3 && !staleTargetObserved; attempt += 1) {
      await view.webContents.loadURL(origin + '/')
      const action = call('fill', { tabId: 'fixture-tab', locator: locator('#name'), text: 'stale' })
      const navigation = view.webContents.loadURL(origin + '/race-' + attempt)
      const [actionResult] = await Promise.allSettled([action, navigation])
      staleTargetObserved = actionResult.status === 'rejected'
    }
    check(staleTargetObserved, 'navigation race allowed an action against a stale target')
    const beforeCrash = await call('get', { tabId: 'fixture-tab' })
    view.webContents.forcefullyCrashRenderer()
    await waitUntil(() => events.some(event => event.method === 'browser:tab-error' && event.params?.tabId === 'fixture-tab' && event.params?.recoverable === true))
    const afterCrash = await call('get', { tabId: 'fixture-tab' })
    check(afterCrash.generation > beforeCrash.generation, 'renderer crash did not revoke the prior document generation')
    await call('reload', { tabId: 'fixture-tab' })
    await call('wait:load', { tabId: 'fixture-tab', timeoutMs: 5000 })
    check((await call('url', { tabId: 'fixture-tab' })).startsWith(origin), 'logical tab did not recover after renderer crash')
    await call('handoff', { tabIds: ['fixture-tab'] })
    const resumed = await runtime.dispatch({ requestId: crypto.randomUUID(), context: { ...context, browserTurnId: 'fixture-turn-2' }, method: 'resumeHandoff', params: {} })
    check(resumed.length === 1 && resumed[0].tabId === 'fixture-tab', 'handoff did not resume in the next Agent turn')
    writeFileSync(resultPath, JSON.stringify({ ok: true, assertions }))
  } finally {
    runtime.destroy()
    win.destroy()
    await new Promise(resolveClose => server.close(resolveClose))
    app.quit()
  }
}).catch(error => {
  writeFileSync(resultPath, JSON.stringify({ ok: false, assertions, error: error?.stack || String(error) }))
  app.exit(1)
})
`
}

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'lume-html-preview-e2e-'))
const appRoot = join(root, 'app')
const fixtureRoot = join(root, 'fixture')
const resultPath = join(root, 'result.json')
mkdirSync(appRoot)
mkdirSync(fixtureRoot)

try {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'file-protocol.ts')
  const build = await Bun.build({ entrypoints: [source], outdir: appRoot, target: 'node', format: 'esm' })
  if (!build.success) throw new Error(build.logs.map(String).join('\n'))
  const builtModule = build.outputs[0]?.path
  if (!builtModule) throw new Error('file protocol module was not built')
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'lume-html-preview-e2e', type: 'module', main: 'main.mjs' }))
  writeFileSync(join(appRoot, 'main.mjs'), electronFixtureMain({
    modulePath: builtModule.replace(/\\/g, '/'),
  }))

  const electronBinary = findElectronBinary()
  const child = spawn(electronBinary, [`--user-data-dir=${join(root, 'user-data')}`, appRoot], {
    env: { ...process.env, LUME_E2E_FIXTURE_ROOT: fixtureRoot, LUME_E2E_RESULT_PATH: resultPath },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exitCode = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Electron preview integration test timed out')) }, 30_000)
    child.once('error', reject)
    child.once('exit', (code) => { clearTimeout(timer); resolveExit(code) })
  })
  if (exitCode !== 0) {
    const fixtureResult = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'no fixture result'
    throw new Error(`Electron exited ${exitCode}\n${stdout}\n${stderr}\n${fixtureResult}`)
  }
  if (!existsSync(resultPath)) throw new Error(`Electron exited without a result\n${stdout}\n${stderr}`)
  const result = JSON.parse(readFileSync(resultPath, 'utf8'))
  if (!result.ok) throw new Error(result.error ?? 'Electron fixture failed')
  console.log(`HTML preview Electron integration passed: ${result.assertions} assertions`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

function findElectronBinary() {
  const executable = process.platform === 'win32' ? 'electron.exe' : 'electron'
  const packageRoot = dirname(Bun.resolveSync('electron/package.json', import.meta.dir))
  const local = join(packageRoot, 'dist', executable)
  if (existsSync(local)) return local
  const configured = process.env.ELECTRON_PATH
  if (configured && existsSync(configured)) return configured
  const worktreesRoot = resolve(process.cwd(), '..')
  if (existsSync(worktreesRoot)) {
    for (const sibling of readdirSync(worktreesRoot)) {
      const candidate = join(worktreesRoot, sibling, 'node_modules', '.bun', 'electron@42.5.1', 'node_modules', 'electron', 'dist', executable)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('A real Electron binary is required; set ELECTRON_PATH or install the workspace Electron package')
}

function electronFixtureMain({ modulePath }) {
  return `
import { app, BrowserWindow, net, protocol, session } from 'electron'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createPreviewProtocolResponse,
  createPreviewScopeRegistry,
  isAllowedPreviewFrameNavigation,
  previewScopeUrl,
  previewTokenFromUrl,
} from 'file:///${modulePath}'

protocol.registerSchemesAsPrivileged([{ scheme: 'lume-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }])
const fixtureRoot = process.env.LUME_E2E_FIXTURE_ROOT
const resultPath = process.env.LUME_E2E_RESULT_PATH
writeFileSync(resultPath, JSON.stringify({ ok:false, error:'fixture started' }))
const registry = createPreviewScopeRegistry()
let assertions = 0
const diagnostics = []
const check = (value, message) => { assertions += 1; if (!value) throw new Error(message) }

app.whenReady().then(async () => {
  const remoteServer = createServer((request, response) => {
    if (request.url === '/remote.js') {
      remoteServer.remoteRequests += 1
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*' })
      response.end('window.remoteScriptLoaded=true')
      return
    }
    response.writeHead(404); response.end()
  })
  remoteServer.remoteRequests = 0
  await new Promise((resolveListen) => remoteServer.listen(0, '127.0.0.1', resolveListen))
  const remoteOrigin = 'http://127.0.0.1:' + remoteServer.address().port
  writeFileSync(join(fixtureRoot, 'style.css'), 'body{color:rgb(1, 2, 3)}')
  writeFileSync(join(fixtureRoot, 'app.js'), 'window.localScriptLoaded=true')
  writeFileSync(join(fixtureRoot, 'data.json'), JSON.stringify({ ok: true }))
  writeFileSync(join(fixtureRoot, 'page.html'), '<p>local page</p>')
  writeFileSync(join(fixtureRoot, '.env'), 'SECRET=1')
  writeFileSync(join(fixtureRoot, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
  writeFileSync(join(fixtureRoot, 'module.mjs'), \`
    const data = await fetch('./data.json').then(response => response.json())
    const dotBlocked = await fetch('./.env').then(response => response.status >= 400).catch(() => true)
    const parentBlocked = await fetch('../secret.js').then(response => response.status >= 400).catch(() => true)
    const imageLoaded = await new Promise(resolve => { const image = new Image(); image.onload=()=>resolve(true); image.onerror=()=>resolve(false); image.src='./pixel.png' })
    document.querySelector('#local').click()
    let topBlocked = false
    try { top.location.href = 'https://example.com/top' } catch { topBlocked = true }
    const popupBlocked = window.open('https://example.com/popup') === null
    setTimeout(() => { try { location.href = 'https://example.com/frame' } catch {} }, 50)
    parent.postMessage({ type:'fixture-result', data:{
      data: data.ok, dotBlocked, parentBlocked, imageLoaded, topBlocked, popupBlocked,
      localScriptLoaded: window.localScriptLoaded === true,
      remoteScriptLoaded: window.remoteScriptLoaded === true,
      css: getComputedStyle(document.body).color,
    }}, '*')
  \`)
  writeFileSync(join(fixtureRoot, 'index.html'), \`<!doctype html><html><head>
    <meta http-equiv="refresh" content="1;url=https://example.com/meta">
    <link rel="stylesheet" href="./style.css">
    <script src="./app.js"></script><script src="\${remoteOrigin}/remote.js"></script>
    <script type="module" src="./module.mjs"></script>
  </head><body><a id="local" href="./page.html">local</a></body></html>\`)

  session.defaultSession.webRequest.onBeforeRequest({ urls: ['lume-file://preview/*'] }, (details, callback) => {
    const token = previewTokenFromUrl(details.url)
    diagnostics.push({ kind:'request', url:details.url, webContentsId:details.webContentsId, owner: registry.owns(token || '', details.webContentsId) })
    callback({ cancel: !token || !registry.owns(token, details.webContentsId) })
  })
  protocol.handle('lume-file', request => createPreviewProtocolResponse(registry, request))
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const ownerId = win.webContents.id
  win.webContents.on('console-message', (_event, level, message) => diagnostics.push({ kind:'console', level, message }))
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => diagnostics.push({ kind:'load-fail', code, description, url, isMainFrame }))
  const scope = registry.create({ kind: 'html-directory', ownerWebContentsId: ownerId, absolutePath: join(fixtureRoot, 'index.html') })
  const previewUrl = previewScopeUrl(scope)
  let preventedNavigations = 0
  win.webContents.on('will-frame-navigate', (event, url, _inPlace, isMainFrame) => {
    if (isMainFrame || isAllowedPreviewFrameNavigation(registry, url, ownerId)) return
    preventedNavigations += 1
    event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.once('destroyed', () => registry.revokeOwner(ownerId))
  const wrapper = \`<!doctype html><iframe id="preview" sandbox="allow-scripts" src="\${previewUrl}"></iframe><script>
    window.fixtureMessages=[]; addEventListener('message', event => { window.fixtureMessages.push(event.data) })
  </script>\`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(wrapper))
  const deadline = Date.now() + 8_000
  let messages = []
  while (Date.now() < deadline) {
    messages = await win.webContents.executeJavaScript('window.fixtureMessages')
    if (messages.some(message => message?.type === 'fixture-result')) break
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  const fixture = messages.find(message => message?.type === 'fixture-result')?.data
  check(Boolean(fixture), 'fixture result was not received: ' + JSON.stringify(diagnostics))
  check(fixture.localScriptLoaded, 'local script did not execute')
  check(fixture.remoteScriptLoaded && remoteServer.remoteRequests > 0, 'remote network script did not execute')
  check(fixture.data, 'opaque-origin module JSON fetch failed')
  check(fixture.imageLoaded, 'local image did not load')
  check(fixture.css === 'rgb(1, 2, 3)', 'local CSS did not apply')
  check(fixture.dotBlocked && fixture.parentBlocked, 'dot-file or parent traversal was not blocked')
  check(fixture.popupBlocked, 'window.open escaped the sandbox')
  check(messages.some(message => message?.type === 'lume-preview-link' && message.kind === 'local'), 'local link bridge did not emit')
  await new Promise(resolveWait => setTimeout(resolveWait, 1_200))
  check(preventedNavigations >= 1, 'frame/meta/top navigation was not intercepted')
  const cacheControl = await win.webContents.executeJavaScript(\`fetch(\${JSON.stringify(previewUrl)}).then(response => response.headers.get('cache-control'))\`)
  check(cacheControl === 'no-store', 'preview response was cacheable')
  const keepAlive = new BrowserWindow({ show: false })
  win.destroy()
  await new Promise(resolveWait => setTimeout(resolveWait, 100))
  check(registry.get(scope.token) === null, 'destroyed webContents retained its token')
  const afterDestroy = await net.fetch(previewUrl).then(response => response.status).catch(() => 0)
  check(afterDestroy === 0 || afterDestroy === 403, 'revoked token remained usable through protocol cache')
  await new Promise(resolveClose => remoteServer.close(resolveClose))
  writeFileSync(resultPath, JSON.stringify({ ok: true, assertions }))
  keepAlive.destroy()
  app.quit()
}).catch(error => {
  writeFileSync(resultPath, JSON.stringify({ ok: false, error: error?.stack || String(error), assertions }))
  app.exit(1)
})
`
}

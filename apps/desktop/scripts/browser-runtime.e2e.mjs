import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'lume-browser-runtime-e2e-'))
const appRoot = join(root, 'app')
const configRoot = join(root, 'config')
const resultPath = join(root, 'result.json')
const popupOnly = process.argv.includes('--popup-only')
mkdirSync(appRoot)
mkdirSync(configRoot)

try {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'browser-runtime.ts')
  const build = await Bun.build({ entrypoints: [source], outdir: appRoot, target: 'node', format: 'esm', external: ['electron'] })
  if (!build.success) throw new Error(build.logs.map(String).join('\n'))
  const builtModule = build.outputs[0]?.path
  if (!builtModule) throw new Error('browser runtime module was not built')
  const guestSource = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'browser-guest-preload.tsx')
  const guestBuild = await Bun.build({ entrypoints: [guestSource], target: 'node', format: 'cjs', external: ['electron'] })
  if (!guestBuild.success || !guestBuild.outputs[0]) throw new Error(guestBuild.logs.map(String).join('\n'))
  const guestPreloadPath = join(appRoot, 'browser-guest-preload.cjs')
  writeFileSync(guestPreloadPath, Buffer.from(await guestBuild.outputs[0].arrayBuffer()))
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'lume-browser-runtime-e2e', type: 'module', main: 'main.mjs' }))
  writeFileSync(join(appRoot, 'main.mjs'), electronFixtureMain(builtModule.replace(/\\/g, '/'), guestPreloadPath.replace(/\\/g, '/')))

  const child = spawn(findElectronBinary(), [`--user-data-dir=${join(root, 'user-data')}`, appRoot], {
    env: { ...process.env, LUME_BROWSER_E2E_CONFIG: configRoot, LUME_BROWSER_E2E_RESULT: resultPath, LUME_BROWSER_POPUP_ONLY: popupOnly ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const exitCode = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      const progress = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'no progress file'
      reject(new Error(`Electron browser runtime fixture timed out\n${stdout}\n${stderr}\n${progress}`))
    }, 45_000)
    child.once('error', reject)
    child.once('exit', code => { clearTimeout(timer); resolveExit(code) })
  })
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null
  if (exitCode !== 0 || !result?.ok) throw new Error(`Electron browser runtime fixture failed\n${stdout}\n${stderr}\n${JSON.stringify(result)}`)
  console.log(`Browser runtime Electron integration passed: ${result.assertions} assertions`)
} finally {
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch {}
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

function electronFixtureMain(modulePath, guestPreloadPath) {
  return `
import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserRuntime } from 'file:///${modulePath}'

const resultPath = process.env.LUME_BROWSER_E2E_RESULT
const configRoot = process.env.LUME_BROWSER_E2E_CONFIG
let assertions = 0
let stage = 'bootstrap'
const setStage = value => { stage = value; writeFileSync(resultPath, JSON.stringify({ ok: false, assertions, stage })) }
const check = (value, message) => { assertions += 1; if (!value) throw new Error(message) }
const checkRejects = async (action, code, message) => {
  assertions += 1
  try { await action() } catch (error) { if (String(error?.message ?? error).includes(code)) return }
  throw new Error(message)
}
const waitUntil = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error('timed out waiting for fixture state')
}
let frameOrigin = ''
const frameServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(\`<!doctype html><title>Cross origin frame</title>
    <input id="frame-name" aria-label="Frame name">
    <button id="frame-submit" onclick="document.querySelector('#frame-result').textContent=document.querySelector('#frame-name').value">Frame apply</button>
    <output id="frame-result"></output>\`)
})
const server = createServer((request, response) => {
  if (request.url === '/popup') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(\`<!doctype html><title>OAuth popup</title><output id="opener"></output><script>document.querySelector('#opener').textContent=window.opener?'present':'missing'</script>\`)
    return
  }
  if (request.url === '/download') {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="fixture.txt"' })
    response.end('download fixture')
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(\`<!doctype html><meta name="viewport" content="width=device-width"><title>Lume fixture</title>
    <label>Name <input id="name" aria-label="Name"></label>
    <button id="submit" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value">Apply</button>
    <button id="annotation-target" onclick="document.querySelector('#annotation-result').textContent='clicked'">Annotation target</button>
    <div id="custom-card" style="cursor:pointer;margin-top:200px" onclick="document.querySelector('#annotation-result').textContent='custom-card'">Custom card</div>
    <button id="open-popup" onclick="window.open('/popup', 'oauth-popup', 'width=520,height=640')">Open popup</button>
    <output id="annotation-result"></output>
    <a id="download" href="/download" download="fixture.txt">Download</a>
    <output id="result"></output>
    <iframe id="cross-origin-frame" src="\${frameOrigin}/"></iframe>
    <form id="search-form" style="display:none;position:fixed;right:8px;bottom:8px;width:260px;height:70px">
      <div style="position:relative;width:260px;height:40px">
        <input id="kw" name="wd" title="搜索" placeholder="请输入搜索内容" style="box-sizing:border-box;width:260px;height:40px">
        <label for="kw" style="position:absolute;inset:0;color:transparent">搜索</label>
      </div>
      <button id="su" type="submit">百度一下</button>
    </form>
    <output id="search-result"></output>
    <script>
      document.querySelector('#search-form').addEventListener('submit', event => {
        event.preventDefault();
        document.querySelector('#search-result').textContent = document.querySelector('#kw').value;
      });
      document.modelContext = {
        getTools: () => [{
          name: 'set_result',
          title: 'Set result',
          description: 'Updates the fixture result.',
          inputSchema: JSON.stringify({ type: 'object', properties: { value: { type: 'string' } } }),
        }],
        executeTool: (_tool, input) => {
          const value = JSON.parse(input);
          document.querySelector('#result').textContent = value.value;
          return JSON.stringify({ applied: value.value });
        },
      };
    </script>\`)
})

app.whenReady().then(async () => {
  await new Promise(resolveListen => frameServer.listen(0, '127.0.0.1', resolveListen))
  frameOrigin = 'http://127.0.0.1:' + frameServer.address().port
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const origin = 'http://127.0.0.1:' + server.address().port
  const win = new BrowserWindow({ show: true, x: 10, y: 10, width: 900, height: 700, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: true } })
  await win.loadURL('data:text/html,<main id="guests" style="position:fixed;inset:0"></main>')
  const events = []
  const guests = new Map()
  const pendingGuestContents = new Map()
  let guestAttachAttempts = 0
  let runtime
  win.webContents.on('will-attach-webview', (event, preferences, params) => {
    guestAttachAttempts += 1
    const grant = runtime?.authorizeGuestMount(win.webContents.id, params.src, params.partition)
    if (!grant) { event.preventDefault(); return }
    preferences.preload = ${JSON.stringify(guestPreloadPath)}
    preferences.sandbox = true
    preferences.contextIsolation = true
    preferences.nodeIntegration = false
    preferences.webSecurity = true
    params.allowpopups = ''
    delete params.preload
    params.partition = grant.partition
  })
  win.webContents.on('did-attach-webview', (_event, contents) => {
    pendingGuestContents.set(contents.id, contents)
  })
  ipcMain.on('lume:get-browser-webmcp-enabled', event => { event.returnValue = true })
  ipcMain.on('lume:browser-guest-mounted', (event, bootstrapUrl) => {
    const contents = pendingGuestContents.get(event.sender.id)
    if (!contents || contents !== event.sender) return
    pendingGuestContents.delete(event.sender.id)
    const token = bootstrapUrl.startsWith('about:blank#lume-browser-mount=') ? bootstrapUrl.slice('about:blank#lume-browser-mount='.length) : ''
    if (!token || !runtime.attachGuest(win.webContents.id, bootstrapUrl, contents)) { contents.close(); return }
    guests.set(token, contents)
  })
  runtime = new BrowserRuntime({
    getWindow: () => win,
    configDir: () => configRoot,
    humanizedInput: false,
    emit: event => events.push(event),
    isAgentPluginEnabled: () => true,
    initialSettings: {
      siteOverrides: { [origin]: 'allow', [frameOrigin]: 'allow' },
      sitePermissionOverrides: { [origin]: { browse: 'allow', download: 'allow' }, [frameOrigin]: { browse: 'allow' } },
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
  const userContext = { actor: 'user', browserSessionId: 'renderer', browserTurnId: 'renderer' }
  const userCall = (method, params = {}) => runtime.dispatch({ requestId: crypto.randomUUID(), context: userContext, method, params })
  const mountTab = async tabId => {
    const attachAttemptsBeforeMount = guestAttachAttempts
    const mount = await userCall('mount:prepare', { tabId })
    check(runtime.authorizeGuestMount(win.webContents.id + 1, mount.bootstrapUrl, mount.partition) === null, 'guest mount accepted a different renderer owner')
    check(runtime.authorizeGuestMount(win.webContents.id, mount.bootstrapUrl, 'persist:forged-browser') === null, 'guest mount accepted a forged partition')
    const repeatedMount = await userCall('mount:prepare', { tabId })
    check(repeatedMount?.mountToken === mount.mountToken, 'a concurrent mount request did not reuse the active mount grant')
    await win.webContents.executeJavaScript(\`(() => { const host = document.querySelector('#guests'); const view = document.createElement('webview'); view.dataset.tabId = \${JSON.stringify(tabId)}; view.setAttribute('partition', \${JSON.stringify(mount.partition)}); view.setAttribute('allowpopups', ''); view.setAttribute('src', \${JSON.stringify(mount.bootstrapUrl)}); view.style.cssText = 'position:absolute;inset:0;width:100%;height:100%'; host.append(view) })()\`)
    await waitUntil(() => guests.has(mount.mountToken) && events.some(event => event.method === 'browser:tab-changed' && event.params?.tabId === tabId && event.params?.generation === mount.generation && event.params?.guestState === 'ready'))
    check(await userCall('mount:prepare', { tabId }) === null, 'an attached guest produced a redundant mount grant')
    check(runtime.authorizeGuestMount(win.webContents.id, mount.bootstrapUrl, mount.partition) === null, 'guest mount token was replayable')
    check(guestAttachAttempts === attachAttemptsBeforeMount + 1, 'one logical mount created more than one renderer guest')
    await win.webContents.executeJavaScript(\`(() => { const view = document.querySelector('webview[data-tab-id="' + \${JSON.stringify(tabId)} + '"]'); view.style.position = 'fixed'; view.style.left = '40px'; view.style.top = '50px'; view.style.width = '620px'; view.style.height = '430px' })()\`)
    await new Promise(resolveLayout => setTimeout(resolveLayout, 50))
    check(guestAttachAttempts === attachAttemptsBeforeMount + 1, 'CSS surface relocation replayed the one-time guest mount token')
    return guests.get(mount.mountToken)
  }
  try {
    setStage('handshake')
    const handshake = await call('handshake')
    check(handshake.protocolVersion === 8 && handshake.minSupported === 5 && handshake.maxSupported === 8, 'browser protocol handshake drifted from the canonical client')
    check(handshake.capabilities.some(capability => capability.id === 'pageAssets'), 'pageAssets capability was not advertised')
    check(handshake.capabilities.some(capability => capability.id === 'webmcp'), 'WebMCP capability was not advertised')
    const created = await call('ensure', { tabId: 'fixture-tab', ownerThreadId: 'fixture-thread' })
    check(created.tabId === 'fixture-tab' && created.backend === 'iab' && created.profileKind === 'agent', 'logical Agent tab was not created')
    const sharedMount = await userCall('mount:prepare', { tabId: 'fixture-tab' })
    check(sharedMount.partition === 'persist:lume-browser', 'Agent tab did not use the shared persistent profile')
    await userCall('mount:release', { tabId: 'fixture-tab', mountToken: sharedMount.mountToken })
    const isolated = await call('ensure', { tabId: 'isolated-tab', sessionKind: 'agent-task' })
    const isolatedMount = await userCall('mount:prepare', { tabId: isolated.tabId })
    check(isolated.profileKind === 'agent' && isolatedMount.partition.startsWith('lume-agent-'), 'explicit isolated Agent tab did not use a temporary profile')
    await userCall('mount:release', { tabId: isolated.tabId, mountToken: isolatedMount.mountToken })
    await userCall('close', { tabId: isolated.tabId })
    const view = await mountTab('fixture-tab')
    check(view && !view.isDestroyed(), 'authorized renderer webview guest was not attached')
    setStage('concurrent-guest-mounts')
    await call('ensure', { tabId: 'concurrent-a' })
    await call('ensure', { tabId: 'concurrent-b' })
    const concurrentMountA = await userCall('mount:prepare', { tabId: 'concurrent-a' })
    const concurrentMountB = await userCall('mount:prepare', { tabId: 'concurrent-b' })
    await win.webContents.executeJavaScript(\`(() => {
      const host = document.querySelector('#guests');
      for (const mount of \${JSON.stringify([concurrentMountA, concurrentMountB])}) {
        const view = document.createElement('webview');
        view.dataset.tabId = mount.tabId;
        view.setAttribute('partition', mount.partition);
        view.setAttribute('allowpopups', '');
        view.setAttribute('src', mount.bootstrapUrl);
        view.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
        host.append(view);
      }
    })()\`)
    await waitUntil(() => [concurrentMountA, concurrentMountB].every(mount => guests.has(mount.mountToken) && events.some(event => event.method === 'browser:tab-changed' && event.params?.tabId === mount.tabId && event.params?.generation === mount.generation && event.params?.guestState === 'ready')))
    check([concurrentMountA, concurrentMountB].every(mount => !guests.get(mount.mountToken)?.isDestroyed()), 'concurrent guest mounts crossed or destroyed their mount tokens')
    await userCall('close', { tabId: 'concurrent-a' })
    await userCall('close', { tabId: 'concurrent-b' })
    const staleMountRelease = await userCall('mount:release', { tabId: 'concurrent-a', mountToken: concurrentMountA.mountToken })
    check(staleMountRelease.released === false, 'releasing a mount after its tab closed was not idempotent')
    const staleVisibility = await userCall('visible', { tabId: 'concurrent-a', visible: false })
    check(staleVisibility.ok === true, 'hiding a tab after its runtime closed was not idempotent')
    await win.webContents.executeJavaScript(\`document.querySelectorAll('webview[data-tab-id^="concurrent-"]').forEach(view => view.remove())\`)
    await waitUntil(() => [concurrentMountA, concurrentMountB].every(mount => guests.get(mount.mountToken)?.isDestroyed()))
    const bounded = await call('bounds', { tabId: 'fixture-tab', x: 20, y: 30, width: 640, height: 480, surface: 'main', visible: true })
    check(bounded.visible && bounded.surface === 'main', 'renderer browser surface metadata was not applied')
    await call('navigate', { tabId: 'fixture-tab', url: origin + '/' })
    const navigatedUrl = await call('url', { tabId: 'fixture-tab' })
    check(navigatedUrl.startsWith(origin), 'fixture navigation failed: ' + JSON.stringify(navigatedUrl))
    const guestUserAgent = await view.executeJavaScript('navigator.userAgent')
    check(!guestUserAgent.includes('Electron') && guestUserAgent.includes('Chrome/'), 'guest user agent still advertises the embedded runtime: ' + guestUserAgent)
    setStage('popup-policy')
    const popupAction = await call('click', { tabId: 'fixture-tab', locator: { version: 1, steps: [{ kind: 'css', selector: '#open-popup' }] } })
    check(popupAction.effect?.kind === 'new_tab_requested', 'Agent action did not report its popup effect')
    check(events.some(event => event.method === 'browser:agent-dispatching' && event.params?.tabId === 'fixture-tab' && event.params?.active === true), 'Agent dispatching state was not broadcast')
    check(events.some(event => event.method === 'browser:agent-dispatching' && event.params?.tabId === 'fixture-tab' && event.params?.active === false), 'Agent idle state was not broadcast')
    await waitUntil(() => events.some(event => event.method === 'browser:popup-request' && event.params?.tabId === 'fixture-tab'))
    check(BrowserWindow.getAllWindows().length === 1, 'Agent-triggered popup bypassed confirmation')
    const popupCreated = new Promise(resolvePopup => view.once('did-create-window', resolvePopup))
    const popupButton = await view.executeJavaScript(\`(() => { const rect = document.querySelector('#open-popup').getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } })()\`)
    view.sendInputEvent({ type: 'mouseDown', x: popupButton.x, y: popupButton.y, button: 'left', clickCount: 1 })
    view.sendInputEvent({ type: 'mouseUp', x: popupButton.x, y: popupButton.y, button: 'left', clickCount: 1 })
    const popupWindow = await Promise.race([popupCreated, new Promise((_, reject) => setTimeout(() => reject(new Error('user popup did not open')), 3000))])
    await popupWindow.webContents.executeJavaScript(\`new Promise(resolve => document.readyState === 'complete' ? resolve() : addEventListener('load', resolve, { once: true }))\`)
    check(await popupWindow.webContents.executeJavaScript(\`document.querySelector('#opener').textContent\`) === 'present', 'user popup lost its opener relationship')
    popupWindow.close()
    // 共同操作模式：用户点击不再暂停 Agent 控制，Agent 请求继续可用
    const afterUserClick = await userCall('get', { tabId: 'fixture-tab' })
    check(afterUserClick.agentControlState === 'active', 'user input paused Agent browser control')
    check((await call('url', { tabId: 'fixture-tab' })).startsWith(origin), 'user click invalidated Agent requests')
    if (process.env.LUME_BROWSER_POPUP_ONLY === '1') {
      writeFileSync(resultPath, JSON.stringify({ ok: true, assertions }))
      return
    }
    setStage('annotation-runtime')
    const annotationSession = await userCall('annotation:session', { tabId: 'fixture-tab', threadId: 'fixture-thread' })
    check(annotationSession.version === 2 && annotationSession.threadId === 'fixture-thread', 'annotation session did not use the bounded v2 contract')
    const commentMode = await userCall('annotation:mode', { tabId: 'fixture-tab', threadId: 'fixture-thread', mode: 'comment' })
    check(commentMode.mode === 'comment', 'annotation comment mode did not persist in the main-process session')
    // Task 102：DOM 渲染层退役，注释 overlay 改由 React AnnotationOverlay 渲染
    // （host 标记 data-lume-annotation-overlay，区别于已删除的 data-lume-annotation-host）。
    await waitUntil(() => view.executeJavaScript("document.querySelector('[data-lume-annotation-overlay]') !== null"))
    await view.executeJavaScript("document.querySelector('#annotation-target').click()")
    check(await view.executeJavaScript("document.querySelector('#annotation-result').textContent") === '', 'comment mode did not intercept the fixture click')
    check(await view.executeJavaScript("document.querySelector('[id^=__lume_review_]') === null") === true, 'legacy DOM annotation overlay is still present')
    await userCall('annotation:preview', { tabId: 'fixture-tab', threadId: 'fixture-thread', original: true })
    await view.executeJavaScript("document.querySelector('#annotation-target').click()")
    check(await view.executeJavaScript("document.querySelector('#annotation-result').textContent") === 'clicked', 'original preview did not restore normal page interaction')
    await view.executeJavaScript("document.querySelector('#annotation-result').textContent = ''")
    await userCall('annotation:preview', { tabId: 'fixture-tab', threadId: 'fixture-thread', original: false })
    await view.executeJavaScript("document.querySelector('#annotation-target').click()")
    check(await view.executeJavaScript("document.querySelector('#annotation-result').textContent") === '', 'leaving original preview did not restore comment interception')
    const browseMode = await userCall('annotation:mode', { tabId: 'fixture-tab', threadId: 'fixture-thread', mode: 'browse' })
    check(browseMode.mode === 'browse', 'annotation browse mode did not restore')
    await view.executeJavaScript("document.querySelector('#annotation-target').click()")
    check(await view.executeJavaScript("document.querySelector('#annotation-result').textContent") === 'clicked', 'browse mode did not restore fixture clicking')
    const moved = await call('bounds', { tabId: 'fixture-tab', x: 680, y: 30, width: 200, height: 480, surface: 'right-panel', visible: true })
    check(moved.surface === 'right-panel' && !view.isDestroyed(), 'surface migration replaced the renderer webview guest')
    check((await call('url', { tabId: 'fixture-tab' })).startsWith(origin), 'surface migration reloaded the page')
    await call('bounds', { tabId: 'fixture-tab', x: 20, y: 30, width: 640, height: 480, surface: 'main', visible: true })
    const geolocationPermission = await view.executeJavaScript("new Promise(resolve => navigator.geolocation.getCurrentPosition(() => resolve('allowed'), error => resolve(error.code === 1 ? 'denied' : 'other'), { timeout: 1000 }))")
    check(geolocationPermission === 'denied', 'agent browser session did not deny site permissions')
    const locator = selector => ({ version: 1, steps: [{ kind: 'css', selector }] })
    await view.executeJavaScript("document.querySelector('#search-form').style.display = 'block'")
    const searchByRole = { version: 1, steps: [{ kind: 'role', role: 'textbox', name: '搜索', exact: true }] }
    await call('fill', { tabId: 'fixture-tab', locator: searchByRole, text: 'agent loop' })
    check(await call('locator:inputValue', { tabId: 'fixture-tab', locator: locator('#kw') }) === 'agent loop', 'role textbox fill did not resolve the associated search label')
    await call('press', { tabId: 'fixture-tab', locator: searchByRole, key: 'Enter' })
    check(await call('locator:innerText', { tabId: 'fixture-tab', locator: locator('#search-result') }) === 'agent loop', 'search textbox Enter did not submit the form')
    check(view.getURL() === origin + '/', 'search textbox Enter unexpectedly navigated: ' + view.getURL())
    await call('fill', { tabId: 'fixture-tab', locator: locator('#kw'), text: 'Lume browser' })
    await call('click', { tabId: 'fixture-tab', locator: locator('#su') })
    check(await call('locator:innerText', { tabId: 'fixture-tab', locator: locator('#search-result') }) === 'Lume browser', 'CSS search textbox fill did not submit the expected value')
    check(view.getURL() === origin + '/', 'search button unexpectedly navigated: ' + view.getURL())
    await view.executeJavaScript("document.querySelector('#search-form').style.display = 'none'")
    await call('fill', { tabId: 'fixture-tab', locator: locator('#name'), text: 'Lume Agent' })
    const inputValue = await view.executeJavaScript("document.querySelector('#name').value")
    check(inputValue === 'Lume Agent', 'locator fill did not update the input: ' + JSON.stringify(inputValue))
    check(await call('locator:inputValue', { tabId: 'fixture-tab', locator: locator('#name') }) === 'Lume Agent', 'locator inputValue did not read the isolated-world DOM')
    check(await call('evaluate:readonly', { tabId: 'fixture-tab', expression: '(arg) => document.querySelector(arg).value', arg: '#name' }) === 'Lume Agent', 'page evaluate did not return its direct read-only value')
    check(await call('locator:evaluate', { tabId: 'fixture-tab', locator: locator('#name'), expression: '(element, suffix) => element.value + suffix', arg: '!' }) === 'Lume Agent!', 'locator evaluate did not receive the strict element')
    await checkRejects(() => call('locator:evaluate', { tabId: 'fixture-tab', locator: locator('#name'), expression: '(element) => { element.value = \"mutated\"; return element.value }' }), 'action_denied', 'locator evaluate allowed a side effect')
    check(await call('locator:inputValue', { tabId: 'fixture-tab', locator: locator('#name') }) === 'Lume Agent', 'rejected locator evaluate changed the page')
    check(await call('locator:count', { tabId: 'fixture-tab', locator: locator('button') }) === 4, 'locator count was incorrect')
    await call('locator:waitFor', { tabId: 'fixture-tab', locator: locator('#submit'), state: 'visible', timeoutMs: 1000 })
    await call('wait:url', { tabId: 'fixture-tab', url: origin + '/*', timeoutMs: 1000 })
    await call('click', { tabId: 'fixture-tab', locator: locator('#submit') })
    const pageResult = await view.executeJavaScript("document.querySelector('#result').textContent")
    check(pageResult === 'Lume Agent', 'locator fill/click did not update the page')
    setStage('semantic-ref')
    const semanticSnapshot = await call('semanticSnapshot', { tabId: 'fixture-tab', interactive_only: true })
    const applyRef = Object.entries(semanticSnapshot.refs).find(([, value]) => value.role === 'button' && value.name === 'Apply')?.[0]
    check(typeof applyRef === 'string', 'semantic snapshot did not expose the Apply button ref')
    await view.executeJavaScript("document.querySelector('#result').textContent = ''")
    await call('click', {
      tabId: 'fixture-tab',
      locator: locator('#submit'),
      semanticRef: applyRef,
      semanticSnapshotId: semanticSnapshot.snapshot_id,
    })
    check(await view.executeJavaScript("document.querySelector('#result').textContent") === 'Lume Agent', 'semantic ref did not resolve the exact backend node')
    const semanticNameRef = Object.entries(semanticSnapshot.refs).find(([, value]) => value.role === 'textbox' && value.name === 'Name')?.[0]
    check(typeof semanticNameRef === 'string', 'semantic snapshot did not expose the Name textbox ref')
    await call('fill', {
      tabId: 'fixture-tab',
      locator: locator('#name'),
      semanticRef: semanticNameRef,
      semanticSnapshotId: semanticSnapshot.snapshot_id,
      text: 'Semantic Ref Fill',
    })
    check(await view.executeJavaScript("document.querySelector('#name').value") === 'Semantic Ref Fill', 'semantic ref fill did not resolve the textbox backend node')
    await view.executeJavaScript("document.querySelector('#name').value = 'Lume Agent'")
    const currentSnapshot = await call('semanticSnapshot', { tabId: 'fixture-tab', interactive_only: true })
    const reusedSnapshot = await call('semanticSnapshot', { tabId: 'fixture-tab', interactive_only: true })
    check(reusedSnapshot.snapshot_id === currentSnapshot.snapshot_id, 'unchanged semantic snapshot did not reuse the cached AX tree')
    const currentApplyRef = Object.entries(currentSnapshot.refs).find(([, value]) => value.role === 'button' && value.name === 'Apply')?.[0]
    const scopedSnapshot = await call('semanticSnapshot', { tabId: 'fixture-tab', scope_ref: '@' + currentApplyRef, snapshot_id: currentSnapshot.snapshot_id })
    check(scopedSnapshot.tree.includes('Apply') && !scopedSnapshot.tree.includes('Name'), 'semantic snapshot scope did not isolate the requested ref subtree')
    await checkRejects(() => call('click', {
      tabId: 'fixture-tab',
      locator: locator('#submit'),
      semanticRef: applyRef,
      semanticSnapshotId: semanticSnapshot.snapshot_id,
    }), 'stale_target', 'a ref from an older snapshot remained actionable')
    const earlyFrameLocator = selector => ({ version: 1, steps: [{ kind: 'frame', selector: '#cross-origin-frame' }, { kind: 'css', selector }] })
    await call('locator:waitFor', { tabId: 'fixture-tab', locator: earlyFrameLocator('#frame-name'), state: 'visible', timeoutMs: 3000 })
    await call('fill', { tabId: 'fixture-tab', locator: earlyFrameLocator('#frame-name'), text: 'Semantic Frame Agent' })
    const frameSnapshot = await call('semanticSnapshot', { tabId: 'fixture-tab', interactive_only: true })
    const frameApplyRef = Object.entries(frameSnapshot.refs).find(([, value]) => value.role === 'button' && value.name === 'Frame apply')?.[0]
    check(typeof frameApplyRef === 'string', 'semantic snapshot did not include the cross-origin frame button')
    await call('click', {
      tabId: 'fixture-tab',
      locator: earlyFrameLocator('#frame-submit'),
      semanticRef: frameApplyRef,
      semanticSnapshotId: frameSnapshot.snapshot_id,
    })
    check(await call('locator:innerText', { tabId: 'fixture-tab', locator: earlyFrameLocator('#frame-result') }) === 'Semantic Frame Agent', 'cross-origin semantic ref did not resolve its backend node')
    const supplementedSnapshot = await call('semanticSnapshot', { tabId: 'fixture-tab', interactive_only: true })
    check(supplementedSnapshot.snapshot_id !== frameSnapshot.snapshot_id, 'child-frame DOM changes incorrectly reused a stale semantic snapshot')
    const customCardRef = Object.entries(supplementedSnapshot.refs).find(([, value]) => value.role === 'clickable' && value.name === 'Custom card')?.[0]
    check(typeof customCardRef === 'string', 'semantic snapshot did not supplement a cursor-pointer element')
    const annotatedScreenshot = await call('screenshot', {
      tabId: 'fixture-tab',
      annotated: true,
      semanticSnapshotId: supplementedSnapshot.snapshot_id,
    })
    check(typeof annotatedScreenshot.data === 'string' && annotatedScreenshot.data.length > 100, 'annotated screenshot was empty')
    check(annotatedScreenshot.annotated_refs.includes('@' + customCardRef), 'annotated screenshot did not reuse the semantic ref')
    await call('click', {
      tabId: 'fixture-tab',
      locator: locator('#custom-card'),
      semanticRef: customCardRef,
      semanticSnapshotId: supplementedSnapshot.snapshot_id,
    })
    check(await view.executeJavaScript("document.querySelector('#annotation-result').textContent") === 'custom-card', 'supplemented cursor-pointer ref was not actionable')
    const webMcpTools = await call('webmcp:list', { tabId: 'fixture-tab' })
    check(webMcpTools.tools.length === 1 && webMcpTools.tools[0].name === 'set_result' && webMcpTools.tools[0].input_schema.type === 'object', 'WebMCP tools were not normalized')
    const webMcpResult = await call('webmcp:invoke', { tabId: 'fixture-tab', toolName: 'set_result', input: { value: 'WebMCP Agent' } })
    check(webMcpResult.result.applied === 'WebMCP Agent' && await view.executeJavaScript("document.querySelector('#result').textContent") === 'WebMCP Agent', 'WebMCP tool invocation failed')
    await view.executeJavaScript("document.querySelector('#result').textContent = ''")
    await call('press', { tabId: 'fixture-tab', locator: locator('#submit'), key: 'Enter' })
    const pressedResult = await view.executeJavaScript("document.querySelector('#result').textContent")
    check(pressedResult === 'Lume Agent', 'locator press did not focus and activate the target: ' + JSON.stringify(pressedResult))
    const frameLocator = selector => ({ version: 1, steps: [{ kind: 'frame', selector: '#cross-origin-frame' }, { kind: 'css', selector }] })
    await call('locator:waitFor', { tabId: 'fixture-tab', locator: frameLocator('#frame-name'), state: 'visible', timeoutMs: 3000 })
    await call('fill', { tabId: 'fixture-tab', locator: frameLocator('#frame-name'), text: 'Cross origin Agent' })
    check(await call('locator:inputValue', { tabId: 'fixture-tab', locator: frameLocator('#frame-name') }) === 'Cross origin Agent', 'cross-origin frame fill/read failed')
    check(await call('locator:evaluate', { tabId: 'fixture-tab', locator: frameLocator('#frame-name'), expression: '(element) => element.value' }) === 'Cross origin Agent', 'cross-origin frame locator evaluate failed')
    await call('click', { tabId: 'fixture-tab', locator: frameLocator('#frame-submit') })
    check(await call('locator:innerText', { tabId: 'fixture-tab', locator: frameLocator('#frame-result') }) === 'Cross origin Agent', 'cross-origin frame click failed')
    const snapshot = await call('snapshot', { tabId: 'fixture-tab' })
    check(Array.isArray(snapshot.documents) && snapshot.documents.length >= 2, 'DOM snapshot did not include the cross-origin frame')
    const pageAssets = await call('pageAssets:list', { tabId: 'fixture-tab' })
    check(pageAssets.summary.totalCount >= 1 && pageAssets.assets.some(asset => asset.url === origin + '/download'), 'page asset inventory missed an observed download asset')
    setStage('screenshot')
    let screenshot
    try { screenshot = await call('screenshot', { tabId: 'fixture-tab' }) } catch (error) {
      check(String(error?.message ?? error).includes('browser_internal_error'), 'headless guest screenshot failed with an unstable error')
    }
    if (screenshot !== undefined) check(typeof screenshot === 'string' && screenshot.length > 100, 'viewport screenshot was empty')
    await call('zoom:set', { tabId: 'fixture-tab', factor: 1.25 })
    check(Math.abs((await call('zoom:get', { tabId: 'fixture-tab' })).factor - 1.25) < 0.01, 'zoom factor did not roundtrip')
    check((await call('list')).length === 1, 'logical tab list drifted from native views')
    const viewportGeneration = (await userCall('get', { tabId: 'fixture-tab' })).generation
    setStage('viewport-commit')
    const committedViewport = await userCall('viewport:commit', { tabId: 'fixture-tab', expectedGeneration: viewportGeneration, revision: 1, state: { enabled: true, width: 640, height: 480, deviceScaleFactor: 1, mobile: false, touch: false, preset: 'responsive', displayScale: 'fit' } })
    check(committedViewport.revision === 1 && committedViewport.viewport.width === 640, 'renderer-first viewport commit did not apply the requested revision')
    setStage('stale-navigation-race')
    let staleTargetObserved = false
    for (let attempt = 0; attempt < 3 && !staleTargetObserved; attempt += 1) {
      await view.loadURL(origin + '/')
      const action = call('fill', { tabId: 'fixture-tab', locator: locator('#name'), text: 'stale' })
      const navigation = view.loadURL(origin + '/race-' + attempt)
      const [actionResult] = await Promise.allSettled([action, navigation])
      staleTargetObserved = actionResult.status === 'rejected'
    }
    check(staleTargetObserved, 'navigation race allowed an action against a stale target')
    await view.loadURL(origin + '/')
    const queuedNavigation = call('navigate', { tabId: 'fixture-tab', url: origin + '/queued-navigation' })
    const queuedOldPageAction = call('fill', { tabId: 'fixture-tab', locator: locator('#name'), text: 'must-not-run' })
    const [queuedNavigationResult, queuedActionResult] = await Promise.allSettled([queuedNavigation, queuedOldPageAction])
    check(queuedNavigationResult.status === 'fulfilled', 'queued navigation did not complete')
    check(queuedActionResult.status === 'rejected' && String(queuedActionResult.reason?.code ?? queuedActionResult.reason?.message).includes('stale_target'), 'an old-page action ran after queued navigation')
    const beforeCrash = await call('get', { tabId: 'fixture-tab' })
    setStage('crash-recovery')
    view.forcefullyCrashRenderer()
    await waitUntil(() => events.some(event => event.method === 'browser:tab-error' && event.params?.tabId === 'fixture-tab' && event.params?.recoverable === true))
    const afterCrash = await call('get', { tabId: 'fixture-tab' })
    check(afterCrash.generation > beforeCrash.generation, 'renderer crash did not revoke the prior document generation')
    await call('reload', { tabId: 'fixture-tab' })
    const recoveredView = await mountTab('fixture-tab')
    await call('wait:load', { tabId: 'fixture-tab', timeoutMs: 5000 })
    const recoveredDescriptor = await call('get', { tabId: 'fixture-tab' })
    const recoveredUrl = await call('url', { tabId: 'fixture-tab' })
    check(recoveredView && !recoveredView.isDestroyed() && recoveredUrl.startsWith(origin), 'logical tab did not recover after renderer crash: ' + JSON.stringify({ recoveredUrl, descriptor: recoveredDescriptor, destroyed: recoveredView?.isDestroyed() }))
    await call('handoff', { tabIds: ['fixture-tab'] })
    const resumed = await runtime.dispatch({ requestId: crypto.randomUUID(), context: { ...context, browserTurnId: 'fixture-turn-2' }, method: 'resumeHandoff', params: {} })
    check(resumed.length === 1 && resumed[0].tabId === 'fixture-tab', 'handoff did not resume in the next Agent turn')
    const secondTurn = { ...context, browserTurnId: 'fixture-turn-2' }
    await runtime.dispatch({ requestId: crypto.randomUUID(), context: secondTurn, method: 'mark', params: { tabId: 'fixture-tab', status: 'deliverable' } })
    await runtime.dispatch({ requestId: crypto.randomUUID(), context: secondTurn, method: 'finalize', params: {} })
    const retained = await runtime.dispatch({ requestId: crypto.randomUUID(), context: { ...context, browserTurnId: 'fixture-turn-3' }, method: 'resumeHandoff', params: {} })
    check(retained.length === 1 && retained[0].tabId === 'fixture-tab', 'deliverable tab was not resumable after turn finalization')
    const resumedAgain = await runtime.dispatch({ requestId: crypto.randomUUID(), context: { ...context, browserTurnId: 'fixture-turn-4' }, method: 'resumeHandoff', params: {} })
    check(resumedAgain.length === 1 && resumedAgain[0].tabId === 'fixture-tab', 'deliverable tab did not remain resumable across later turns')
    writeFileSync(resultPath, JSON.stringify({ ok: true, assertions }))
  } finally {
    runtime.destroy()
    win.destroy()
    await new Promise(resolveClose => server.close(resolveClose))
    await new Promise(resolveClose => frameServer.close(resolveClose))
    app.quit()
  }
}).catch(error => {
  writeFileSync(resultPath, JSON.stringify({ ok: false, assertions, stage, error: error?.stack || String(error) }))
  app.exit(1)
})
`
}

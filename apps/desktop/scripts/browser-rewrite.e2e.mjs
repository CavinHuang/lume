/**
 * 浏览器重写 E2E 冒烟(browser rewrite)—— 需要真实显示环境(创建可见 BrowserWindow +
 * webview guest)。无显示环境跑不起来;CI/无头机器请跳过。
 *
 * 运行:package.json `test:browser-rewrite-e2e`
 *   = node --check 本脚本(语法闸) + bun test 本文件(Electron 实跑)。
 * 自检模式(`LUME_E2E_SELF_CHECK=1`):只做 Bun.build 打包 + 产物语法检查,
 * 不启动 Electron(无显示环境验证脚本与导入可解析)。
 *
 * 流程(建模自旧版 scripts/browser-runtime.e2e.mjs,@23c03fea9~1):
 *   1. Bun.build 打包 src/browser/{assemble,restore-protocol,guest-preload}.ts → fixture 应用目录;
 *   2. 生成 fixture main.mjs(spawn Electron);
 *   3. fixture 内装配 createLumeBrowserRuntime(等价 main.setupBrowserRuntime),并以
 *      fixture renderer 模拟真实面板协议:browser-view-ready/restore → 挂 webview +
 *      attachGuest;suspend → 卸载空壳 + suspend-ready ack;screenshot-surface-prepare
 *      → ready 回报;
 *   4. 驱动:newTab → attachGuest 断言 → navigate(本地 HTTP)→ snapshot →
 *      screenshot → 后台化 + suspendScheduler.tick() 挂起 → suspended 断言 →
 *      ensureResident 唤醒 → 恢复断言(URL/驻留态)→ recording start/status/cancel →
 *      close → 恢复存储文件断言。
 * 结果经 result.json 传回:退出码 0 且 {ok:true} 才算通过。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON_LAUNCH_TIMEOUT_MS = 180_000

test('browser rewrite electron smoke (requires a display)', { timeout: ELECTRON_LAUNCH_TIMEOUT_MS + 60_000 }, async () => {
  assert.ok(typeof Bun !== 'undefined', 'browser-rewrite e2e must run under bun (needs Bun.build)')
  const root = mkdtempSync(join(tmpdir(), 'lume-browser-rewrite-e2e-'))
  const appRoot = join(root, 'app')
  const configRoot = join(root, 'config')
  const resultPath = join(root, 'result.json')
  mkdirSync(appRoot)
  mkdirSync(configRoot)
  let child = null
  try {
    /* 1. 打包浏览器核心(assemble 含全部 core 模块;@lume/shared 一并内联)。 */
    const build = await Bun.build({
      entrypoints: [
        resolve(desktopRoot, 'src/browser/assemble.ts'),
        resolve(desktopRoot, 'src/browser/restore-protocol.ts'),
        resolve(desktopRoot, 'src/browser/guest-preload.ts'),
      ],
      outdir: appRoot,
      target: 'node',
      format: 'esm',
      external: ['electron'],
      naming: { entry: '[name].mjs' },
    })
    assert.equal(build.success, true, 'browser core bundle failed: ' + build.logs.map(String).join('\n'))
    const guestPreloadPath = join(appRoot, 'guest-preload.cjs')
    const { GUEST_PRELOAD_SOURCE } = await import(pathToFileURL(join(appRoot, 'guest-preload.mjs')).href)
    writeFileSync(guestPreloadPath, GUEST_PRELOAD_SOURCE)

    const fixtureMainPath = join(appRoot, 'main.mjs')
    writeFileSync(
      join(appRoot, 'package.json'),
      JSON.stringify({ name: 'lume-browser-rewrite-e2e', type: 'module', main: 'main.mjs' }),
    )
    writeFileSync(fixtureMainPath, fixtureMainSource({
      assembleUrl: pathToFileURL(join(appRoot, 'assemble.mjs')).href,
      restoreProtocolUrl: pathToFileURL(join(appRoot, 'restore-protocol.mjs')).href,
      guestPreloadUrl: pathToFileURL(join(appRoot, 'guest-preload.mjs')).href,
      guestPreloadPath,
      configDir: join(configRoot, 'config'),
      resultPath,
    }))

    if (process.env.LUME_E2E_SELF_CHECK === '1') {
      // 无显示环境闸:打包产物与 fixture 语法可解析即通过,不启动 Electron。
      for (const path of [fixtureMainPath, 'assemble.mjs', 'restore-protocol.mjs', 'guest-preload.mjs'].map(entry => entry === fixtureMainPath ? entry : join(appRoot, entry))) {
        const check = spawnSync('node', ['--check', path], { stdio: 'pipe' })
        assert.equal(check.status, 0, `syntax check failed for ${path}: ${check.stderr}`)
      }
      console.log('browser-rewrite e2e self-check passed (bundle + fixture syntax)')
      return
    }

    /* 2. 启动 Electron fixture。 */
    const electronBinary = findElectronBinary()
    child = spawn(electronBinary, [`--user-data-dir=${join(root, 'user-data')}`, appRoot], {
      env: {
        ...process.env,
        LUME_BROWSER_REWRITE_E2E_RESULT: resultPath,
        LUME_BROWSER_REWRITE_E2E_CONFIG: configRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const exitCode = await new Promise((resolveExit, reject) => {
      const timer = setTimeout(() => {
        child?.kill()
        const progress = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'no progress file'
        reject(new Error(`Electron fixture timed out\n${stdout}\n${stderr}\n${progress}`))
      }, ELECTRON_LAUNCH_TIMEOUT_MS)
      child.once('error', reject)
      child.once('exit', code => { clearTimeout(timer); resolveExit(code) })
    })

    /* 3. 结果断言。 */
    const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null
    assert.equal(exitCode, 0, `Electron fixture exited ${exitCode}\n${stdout}\n${stderr}`)
    assert.equal(result?.ok, true, `fixture failed at stage=${result?.stage}: ${result?.error ?? 'unknown'}`)
    assert.ok((result?.assertions ?? 0) >= 10, 'fixture reported too few assertions')
    console.log(`browser-rewrite e2e passed: ${result.assertions} assertions`)
  } finally {
    child?.kill()
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { /* 临时目录清理失败可忽略 */ }
  }
})

function findElectronBinary() {
  if (process.env.ELECTRON_PATH && existsSync(process.env.ELECTRON_PATH)) return process.env.ELECTRON_PATH
  const executable = process.platform === 'win32' ? 'electron.exe' : 'electron'
  const candidates = []
  try {
    candidates.push(join(dirname(Bun.resolveSync('electron/package.json', import.meta.dir)), 'dist', executable))
  } catch { /* fallthrough */ }
  // 同根 worktree/checkout 回退(旧版 browser-runtime.e2e.mjs 同款):本 worktree
  // 未下载 electron 二进制时,借用相邻 checkout(如主 checkout)的 dist。
  const repositoryRoot = resolve(desktopRoot, '..', '..')
  const worktreesRoot = dirname(repositoryRoot)
  for (const sibling of existsSync(worktreesRoot) ? readdirSync(worktreesRoot) : []) {
    const siblingRoot = join(worktreesRoot, sibling)
    if (siblingRoot === repositoryRoot) continue
    candidates.push(
      join(siblingRoot, 'apps', 'desktop', 'node_modules', 'electron', 'dist', executable),
      join(siblingRoot, 'node_modules', 'electron', 'dist', executable),
    )
  }
  const found = candidates.find(path => existsSync(path))
  if (found) return found
  throw new Error('A real Electron binary is required (devDependency electron or ELECTRON_PATH)')
}

/**
 * fixture main 源码(模板仅注入路径/常量;内部代码纯单引号字符串拼接,避免嵌套模板转义)。
 * fixture = "main + renderer 面板" 合体:runtime 装配 + 模拟 renderer 协议 + 驱动断言。
 */
function fixtureMainSource({ assembleUrl, restoreProtocolUrl, guestPreloadUrl, guestPreloadPath, configDir, resultPath }) {
  return `import { app, BrowserWindow, session } from 'electron'
import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLumeBrowserRuntime } from ${JSON.stringify(assembleUrl)}
import { ensureBrowserRestoreSchemePrivileged, installBrowserRestoreBootstrapProtocol } from ${JSON.stringify(restoreProtocolUrl)}

const WORKSPACE = 'fixture-workspace'
const SESSION = 'fixture-session'
const PARTITION = 'persist:lume-browser'
const RESTORE_PENDING_URL = 'lume-browser-restore://pending'
const GUEST_PRELOAD_CJS = ${JSON.stringify(guestPreloadPath)}
const CONFIG_DIR = ${JSON.stringify(configDir)}
const RESULT_PATH = ${JSON.stringify(resultPath)}
const ALLOWED_SRC_PROTOCOLS = ['about:', 'data:', 'http:', 'https:', 'lume-browser-restore:']

let assertions = 0
let stage = 'bootstrap'
let runtime
const writeProgress = (ok, error) => {
  try { writeFileSync(RESULT_PATH, JSON.stringify({ ok, assertions, stage, ...(error ? { error } : {}) })) } catch {}
}
const setStage = (value) => { stage = value; writeProgress(false) }
const check = (value, message) => { assertions += 1; if (!value) throw new Error(message) }
const waitUntil = async (predicate, timeoutMs, message) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(message)
}
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))
let requestSeq = 0
const makeContext = (windowId) => ({
  requestId: 'fixture-req-' + (++requestSeq),
  browserId: 'fixture-iab',
  browserGeneration: 0,
  windowId,
  workspaceKey: WORKSPACE,
  sessionId: SESSION,
  clientMode: 'desktop-continuous',
})

ensureBrowserRestoreSchemePrivileged()

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><title>Lume rewrite fixture</title>'
    + '<h1 id="fixture-marker">rewrite fixture</h1>'
    + '<button id="fixture-apply" onclick="document.querySelector(\\'#fixture-result\\').textContent=\\'applied\\'">Apply</button>'
    + '<output id="fixture-result"></output>')
})

app.whenReady().then(async () => {
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const origin = 'http://127.0.0.1:' + server.address().port
  const win = new BrowserWindow({
    show: true, x: 20, y: 20, width: 1000, height: 760, skipTaskbar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: true },
  })
  setStage('host-page')
  await win.loadURL('data:text/html,<main id="guests" style="position:fixed;inset:0"></main>')
  const detachRestoreProtocol = installBrowserRestoreBootstrapProtocol(session.fromPartition(PARTITION))

  /* webview guest 加固(与 ipc.ts hardenWindowForBrowserGuests 同基线)。 */
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = typeof params.src === 'string' ? params.src : 'about:blank'
    try {
      const protocol = new URL(src).protocol
      if (!ALLOWED_SRC_PROTOCOLS.includes(protocol)) {
        console.log('[fixture] blocked unsupported webview src: ' + src)
        event.preventDefault()
        return
      }
    } catch {
      event.preventDefault()
      return
    }
    webPreferences.preload = GUEST_PRELOAD_CJS
    webPreferences.contextIsolation = true
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = true
    webPreferences.sandbox = true
    delete params.preload
    params.nodeintegrationinsubframes = 'true'
    delete params.disablewebsecurity
    delete params.allowpopups
    params.allowpopups = 'true'
    params.partition = PARTITION
  })

  /* ── runtime 装配(等价 main.setupBrowserRuntime)+ 模拟 renderer 面板协议 ── */
  const events = []
  const tabViews = new Map() // tabId → { webContentsId }
  win.webContents.on('did-attach-webview', (_event, contents) => {
    runtime.dialogController.bindGuest(PARTITION, contents.id, win.id)
  })
  runtime = createLumeBrowserRuntime({
    getWindow: () => (win.isDestroyed() ? null : win),
    emit: (event) => {
      events.push(event)
      try { handleBrowserViewEvent(event) } catch (error) { console.log('[fixture] event handler failed', error) }
    },
    log: (message) => console.log('[browser]', message),
    warn: (message, error) => console.log('[browser warn]', message, error ?? ''),
    configDir: CONFIG_DIR,
    suspendIdleDelayMs: 500,
  })

  const mountScript = (tabId, src) => '(function(){const host=document.querySelector(\\'#guests\\');'
    + 'const view=document.createElement(\\'webview\\');'
    + 'view.setAttribute(\\'partition\\',' + JSON.stringify(PARTITION) + ');'
    + 'view.setAttribute(\\'src\\',' + JSON.stringify(src) + ');'
    + 'view.dataset.tabId=' + JSON.stringify(tabId) + ';'
    + 'view.style.cssText=\\'position:absolute;left:0;top:0;width:100%;height:100%\\';'
    + 'host.appendChild(view)})()'
  const readWebContentsIdScript = (tabId) =>
    '(function(){const view=document.querySelector(\\'webview[data-tab-id="' + tabId + '"]\\');'
    + 'if(!view) return null; try { return view.getWebContentsId() } catch { return null }})()'
  const removeViewScript = (tabId) =>
    '(function(){document.querySelectorAll(\\'webview[data-tab-id="' + tabId + '"]\\').forEach(v => v.remove())})()'

  /** 模拟 renderer 挂载:webview(常规 about:blank / 恢复期停靠页)→ attachGuest → 驻留上报。 */
  const mountTab = async (tabId, residencyGeneration) => {
    const restorePending = residencyGeneration !== undefined
    if (!restorePending && tabViews.has(tabId)) return
    await win.webContents.executeJavaScript(mountScript(tabId, restorePending ? RESTORE_PENDING_URL : 'about:blank'))
    const webContentsId = await waitUntil(async () => {
      const id = await win.webContents.executeJavaScript(readWebContentsIdScript(tabId)).catch(() => null)
      return typeof id === 'number' && id > 0 ? id : null
    }, 10_000, 'webview guest did not attach for tabId=' + tabId)
    const attach = await runtime.attachGuest({
      tabId,
      webContentsId,
      windowId: win.id,
      active: true,
      workspaceKey: WORKSPACE,
      sessionId: SESSION,
      ...(restorePending ? { residencyGeneration } : {}),
    })
    check(attach?.ok === true, 'attachGuest failed for tabId=' + tabId + ': ' + JSON.stringify(attach))
    tabViews.set(tabId, { webContentsId })
    await runtime.reportResidency({
      tabId, windowId: win.id, workspaceKey: WORKSPACE, sessionId: SESSION,
      selected: true, visible: true, loading: false, restoreUrl: '', title: null, currentTask: false,
    })
  }

  /** 模拟 renderer 挂起应答:detach-guest → 卸载空壳 → suspend-ready ack。 */
  const ackSuspend = async (tabId, generation) => {
    const view = tabViews.get(tabId)
    if (view) {
      await runtime.detachGuest(tabId, view.webContentsId, win.id).catch(() => false)
      await win.webContents.executeJavaScript(removeViewScript(tabId)).catch(() => {})
      tabViews.delete(tabId)
    }
    await runtime.suspendReady({ tabId, generation, windowId: win.id })
  }

  function handleBrowserViewEvent(event) {
    const params = event.params ?? {}
    if (event.method === 'lume:browser-view-ready') {
      void mountTab(params.tabId, undefined).catch(error => console.log('[fixture] mount failed', error))
    } else if (event.method === 'lume:browser-view-restore' && params.residency === 'restoring') {
      void mountTab(params.tabId, params.generation).catch(error => console.log('[fixture] restore mount failed', error))
    } else if (event.method === 'lume:browser-view-suspend' && params.residency === 'suspend-pending') {
      void ackSuspend(params.tabId, params.generation).catch(error => console.log('[fixture] suspend ack failed', error))
    } else if (event.method === 'lume:browser-view-screenshot-surface-prepare') {
      runtime.handleScreenshotSurfaceReady({
        windowId: win.id,
        requestId: params.requestId,
        workspaceKey: params.workspaceKey,
        sessionId: params.sessionId,
        browserId: params.browserId,
        browserGeneration: params.browserGeneration,
        tabId: params.tabId,
        webContentsId: params.webContentsId,
        viewport: params.viewport,
        surfaceScale: 1,
      }, win.webContents.id)
    } else if (event.method === 'lume:browser-view-close-tab') {
      tabViews.delete(params.tabId)
      void win.webContents.executeJavaScript(removeViewScript(params.tabId)).catch(() => {})
    }
  }

  const residencyOf = (tabId) => runtime.manager.listSuspendViews().find(view => view.tabId === tabId) ?? null

  try {
    /* ── 驱动:开 tab → 导航 → 快照 → 截图 → 挂起 → 唤醒 → 录制 → 关闭 ── */
    setStage('open-tab')
    const created = await runtime.execute(makeContext(win.id), { method: 'newTab' })
    check(created.ok === true, 'newTab failed: ' + JSON.stringify(created.error ?? created))
    const tabId = created.tab.tabId
    await waitUntil(() => runtime.manager.hasGuest(tabId), 10_000, 'guest did not become resident after newTab')
    check(tabViews.has(tabId), 'fixture renderer did not mount the guest webview')

    setStage('navigate')
    const navigated = await runtime.execute(makeContext(win.id), { method: 'navigate', tabId, url: origin + '/' })
    check(navigated.ok === true, 'navigate failed: ' + JSON.stringify(navigated.error ?? navigated))

    setStage('dom-snapshot')
    const snapshot = await runtime.execute(makeContext(win.id), { method: 'snapshot', tabId })
    check(snapshot.ok === true, 'snapshot failed: ' + JSON.stringify(snapshot.error ?? snapshot))
    check(JSON.stringify(snapshot.snapshot ?? '').includes('fixture-marker'), 'snapshot missed the fixture marker')

    setStage('screenshot')
    const screenshot = await runtime.execute(makeContext(win.id), { method: 'screenshot', tabId })
    check(
      screenshot.ok === true && typeof screenshot.image?.base64 === 'string' && screenshot.image.base64.length > 100,
      'screenshot failed: ' + JSON.stringify(screenshot.error ?? { length: screenshot.image?.base64?.length }),
    )

    setStage('suspend')
    await runtime.reportResidency({
      tabId, windowId: win.id, workspaceKey: WORKSPACE, sessionId: SESSION,
      selected: false, visible: false, loading: false, restoreUrl: origin + '/', title: 'Lume rewrite fixture', currentTask: false,
    })
    await waitUntil(() => {
      const view = residencyOf(tabId)
      return view?.residency === 'live-background' && view?.visible === false
    }, 5_000, 'tab did not settle into live-background')
    await delay(600) // 越过 suspendIdleDelayMs(500)
    const suspendCandidates = await runtime.suspendScheduler.tick()
    check(suspendCandidates.includes(tabId), 'scheduler skipped the idle tab: ' + JSON.stringify(suspendCandidates))
    check(
      events.some(event => event.method === 'lume:browser-view-suspend'
        && event.params?.tabId === tabId && event.params?.residency === 'suspend-pending'),
      'no lume:browser-view-suspend notification was emitted',
    )
    await waitUntil(() => residencyOf(tabId)?.residency === 'suspended', 5_000, 'tab did not reach suspended residency')
    check(!runtime.manager.hasGuest(tabId), 'guest webContents survived suspension')

    setStage('wake')
    await runtime.ensureResident({ tabId, windowId: win.id, workspaceKey: WORKSPACE, sessionId: SESSION })
    await waitUntil(() => runtime.manager.hasGuest(tabId), 10_000, 'guest did not re-attach after ensureResident')
    check(
      events.some(event => event.method === 'lume:browser-view-restore'
        && event.params?.tabId === tabId && event.params?.residency === 'restoring'),
      'no lume:browser-view-restore notification was emitted',
    )
    const state = await runtime.execute(makeContext(win.id), { method: 'getState', tabId })
    check(
      state.ok === true && String(state.state?.url ?? '').startsWith(origin),
      'page state was not restored after wake: ' + JSON.stringify(state.state ?? state.error),
    )
    const residencyAfterWake = residencyOf(tabId)?.residency
    check(
      residencyAfterWake === 'live-visible' || residencyAfterWake === 'live-background',
      'residency did not return to live after wake: ' + String(residencyAfterWake),
    )

    setStage('recording')
    const recordStart = await runtime.execute(makeContext(win.id), {
      method: 'recordingStart', tabId, options: { fps: 5, maxDurationMs: 8_000 },
    })
    check(recordStart.ok === true, 'recordingStart failed: ' + JSON.stringify(recordStart.error ?? recordStart))
    const recordingId = recordStart.recording?.id
    check(typeof recordingId === 'string', 'recordingStart returned no recording id')
    await delay(300)
    const recordStatus = await runtime.execute(makeContext(win.id), { method: 'recordingStatus', tabId, recordingId })
    check(
      recordStatus.ok === true && recordStatus.recording?.status === 'running',
      'recording was not running after start: ' + JSON.stringify(recordStatus.error ?? recordStatus.recording),
    )
    const recordCancel = await runtime.execute(makeContext(win.id), { method: 'recordingCancel', tabId, recordingId })
    check(
      recordCancel.ok === true && recordCancel.recording?.status === 'cancelled',
      'recordingCancel did not cancel: ' + JSON.stringify(recordCancel.error ?? recordCancel.recording),
    )

    setStage('close')
    const closed = await runtime.execute(makeContext(win.id), { method: 'close', tabId })
    check(closed.ok === true, 'close failed: ' + JSON.stringify(closed.error ?? closed))
    check(!runtime.manager.tabs.has(tabId), 'closed tab is still registered')

    setStage('recovery-store')
    await runtime.manager.whenRecoveryIdle()
    const storePath = join(CONFIG_DIR, 'browser-recovery', 'store.json')
    check(existsSync(storePath), 'recovery store file was never written')
    const storePayload = JSON.parse(readFileSync(storePath, 'utf8'))
    check(storePayload.schemaVersion === 1, 'recovery store schemaVersion drifted: ' + JSON.stringify(storePayload.schemaVersion))
    check(Array.isArray(storePayload.shells), 'recovery store shells must be an array')
    check(
      !storePayload.shells.some(shell => shell.tabId === tabId),
      'closed tab shell survived in the recovery store',
    )

    runtime.dispose()
    detachRestoreProtocol()
    writeProgress(true)
  } catch (error) {
    writeProgress(false, error?.stack || String(error))
    try { runtime?.dispose() } catch {}
    await new Promise(resolve => server.close(resolve))
    app.exit(1)
    return
  }
  await new Promise(resolve => server.close(resolve))
  app.quit()
}).catch(error => {
  writeProgress(false, error?.stack || String(error))
  app.exit(1)
})
`
}

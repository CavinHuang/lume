import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  console.log('Windows user-presence smoke skipped on this platform')
  process.exit(0)
}

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(desktopRoot, '../..')
const helperPath = resolve(desktopRoot, 'resources/desktop-host/win32-x64-msvc/lume_desktop_host.exe')
const manifestPath = resolve(desktopRoot, 'resources/desktop-host-manifest.json')
if (!existsSync(helperPath) || !existsSync(manifestPath)) throw new Error('Build desktop-host resources before running the user-presence smoke')

const root = mkdtempSync(join(tmpdir(), 'lume-user-presence-smoke-'))
const appRoot = join(root, 'app')
const resultPath = join(root, 'result.json')
mkdirSync(appRoot)

try {
  const source = resolve(desktopRoot, 'src/user-presence.ts')
  const build = await Bun.build({ entrypoints: [source], outdir: appRoot, target: 'node', format: 'esm', external: ['electron'] })
  if (!build.success) throw new Error(build.logs.map(String).join('\n'))
  const modulePath = build.outputs[0]?.path
  if (!modulePath) throw new Error('user-presence module was not built')
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'lume-user-presence-smoke', type: 'module', main: 'main.mjs' }))
  writeFileSync(join(appRoot, 'main.mjs'), electronFixture({
    modulePath: modulePath.replace(/\\/g, '/'),
    helperPath: helperPath.replace(/\\/g, '/'),
    manifestPath: manifestPath.replace(/\\/g, '/'),
  }))

  const child = spawn(findElectronBinary(repositoryRoot), [`--user-data-dir=${join(root, 'user-data')}`, appRoot], {
    env: { ...process.env, LUME_USER_PRESENCE_RESULT: resultPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const exitCode = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Windows user-presence smoke timed out')) }, 90_000)
    child.once('error', reject)
    child.once('exit', code => { clearTimeout(timer); resolveExit(code) })
  })
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null
  if (exitCode !== 0 || result?.authorized !== true) {
    throw new Error(`Windows user-presence smoke failed\n${stdout}\n${stderr}\n${JSON.stringify(result)}`)
  }
  console.log('Windows fresh user-presence verification passed')
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

function findElectronBinary(repositoryRoot) {
  const candidates = [
    resolve(repositoryRoot, 'node_modules/.bun/electron@42.5.1/node_modules/electron/dist/electron.exe'),
    process.env.ELECTRON_PATH,
  ].filter(Boolean)
  const worktreesRoot = resolve(repositoryRoot, '..')
  for (const sibling of existsSync(worktreesRoot) ? readdirSync(worktreesRoot) : []) {
    candidates.push(join(worktreesRoot, sibling, 'node_modules', '.bun', 'electron@42.5.1', 'node_modules', 'electron', 'dist', 'electron.exe'))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  const executable = Bun.spawnSync(['where.exe', 'electron.exe'])
  const discovered = executable.success ? executable.stdout.toString().split(/\r?\n/).find(Boolean) : undefined
  if (discovered && existsSync(discovered)) return discovered
  throw new Error('A real Electron binary is required')
}

function electronFixture({ modulePath, helperPath, manifestPath }) {
  return `
import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { requestFreshUserPresence } from 'file:///${modulePath}'

const resultPath = process.env.LUME_USER_PRESENCE_RESULT
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true,
    width: 440,
    height: 180,
    title: 'Lume 用户验证测试',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<style>body{font:16px system-ui;padding:28px;background:#181818;color:#fff}</style><body>请在系统弹窗中确认身份，以验证 Lume 的凭证保护。</body>'))
  const authorized = await requestFreshUserPresence({
    binaryPath: '${helperPath}',
    manifestPath: '${manifestPath}',
    targetId: 'win32-x64-msvc',
    nativeWindowHandle: win.getNativeWindowHandle(),
    reason: '验证 Lume 浏览器凭证保护',
    timeoutMs: 60_000,
  })
  writeFileSync(resultPath, JSON.stringify({ authorized }))
  win.destroy()
  app.exit(authorized ? 0 : 1)
}).catch(error => {
  writeFileSync(resultPath, JSON.stringify({ authorized: false, error: error?.stack || String(error) }))
  app.exit(1)
})
`
}

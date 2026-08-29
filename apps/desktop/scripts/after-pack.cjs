const { execFileSync } = require('node:child_process')
const { existsSync, readdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')

// officecli 按平台-架构子目录分发；mac 单 runner 会同时下载 arm64/x64 两个目标，
// 打包后修剪掉非当前 arch 的目录，避免每个 DMG 多背约 34MB 的异架构二进制。
function pruneOfficeCliResources(context) {
  const resourcesDir = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  const officeCliRoot = join(resourcesDir, 'officecli')
  if (!existsSync(officeCliRoot)) return
  const keepTarget = `${context.electronPlatformName}-${context.arch}`
  for (const entry of readdirSync(officeCliRoot)) {
    if (entry === keepTarget) continue
    rmSync(join(officeCliRoot, entry), { recursive: true, force: true })
  }
}

// 对齐 Proma 的 mac.binaries：officecli 是外部未签名二进制，Developer ID 公证前
// 必须以同身份先行签名（electron-builder 的静态 binaries 列表与按 arch 修剪冲突，
// 故在此按当前 arch 手动签名，时序上 afterPack 先于签名钩子）。无身份环境
// （本地/CI ad-hoc 路径）交给既有 --deep 深度签名覆盖。
function signOfficeCliBinary(context) {
  if (context.electronPlatformName !== 'darwin') return
  const identity = process.env.LUME_COMPUTER_USE_CODESIGN_IDENTITY
  if (!identity) return
  const binaryPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents', 'Resources', 'officecli',
    `${context.electronPlatformName}-${context.arch}`,
    'officecli',
  )
  if (!existsSync(binaryPath)) return
  execFileSync('/usr/bin/codesign', [
    '--force',
    '--options',
    'runtime',
    '--timestamp',
    '--sign',
    identity,
    binaryPath,
  ], { stdio: 'inherit' })
}

module.exports = async function afterPack(context) {
  pruneOfficeCliResources(context)
  signOfficeCliBinary(context)
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.LUME_RELEASE_SIGNING_REQUIRED === '1') return

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const entitlementsPath = join(__dirname, '..', 'assets', 'entitlements.mac.plist')
  execFileSync('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    '--options',
    'runtime',
    '--entitlements',
    entitlementsPath,
    '--timestamp=none',
    appPath,
  ], { stdio: 'inherit' })
}

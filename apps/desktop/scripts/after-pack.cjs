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

module.exports = async function afterPack(context) {
  pruneOfficeCliResources(context)
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

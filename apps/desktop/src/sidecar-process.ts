import { dirname, join, resolve } from 'node:path'

export const SIDECAR_BUNDLE_NAME = 'index.mjs'
export const NATIVE_BINARY_NAME = 'lume-natives.node'

export function getSidecarScriptPath({ appIsPackaged, resourcesPath, desktopRoot }) {
  if (appIsPackaged) {
    return join(resourcesPath, 'sidecar', SIDECAR_BUNDLE_NAME)
  }
  return resolve(desktopRoot, 'resources', 'sidecar', SIDECAR_BUNDLE_NAME)
}

export function getNativeTargetId({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === 'win32' && arch === 'x64') return 'win32-x64-msvc'
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64'
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64-gnu'
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64-gnu'
  throw new Error(`unsupported native target: ${platform}-${arch}`)
}

export function getNativeBinaryPath({
  appIsPackaged,
  resourcesPath,
  desktopRoot,
  platform = process.platform,
  arch = process.arch,
}) {
  const targetId = getNativeTargetId({ platform, arch })
  if (appIsPackaged) {
    return join(resourcesPath, 'natives', targetId, NATIVE_BINARY_NAME)
  }
  return resolve(desktopRoot, 'resources', 'natives', targetId, NATIVE_BINARY_NAME)
}

export function createUtilityProcessSidecarForkConfig({ sidecarScriptPath, env }) {
  return {
    modulePath: sidecarScriptPath,
    args: [],
    options: {
      cwd: dirname(sidecarScriptPath),
      env,
      serviceName: 'Lume Sidecar',
      stdio: 'pipe',
    },
  }
}

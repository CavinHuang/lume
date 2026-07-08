import { dirname, join, resolve } from 'node:path'

export const SIDECAR_BUNDLE_NAME = 'index.mjs'
export const NATIVE_BINARY_NAME = 'lume-natives.node'
export const NODE_REPL_BINARY_NAME = 'node_repl'
export const DESKTOP_HOST_BINARY_NAME = 'lume_desktop_host'
export const DESKTOP_HOST_MAC_APP_NAME = 'Lume Computer Use.app'

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

export function getNodeReplRootPath({ appIsPackaged, resourcesPath, desktopRoot }) {
  if (appIsPackaged) {
    return join(resourcesPath, 'node-repl')
  }
  return resolve(desktopRoot, 'resources', 'node-repl')
}

export function getNodeReplHostBinaryPath({
  appIsPackaged,
  resourcesPath,
  desktopRoot,
  platform = process.platform,
}) {
  const fileName = platform === 'win32' ? `${NODE_REPL_BINARY_NAME}.exe` : NODE_REPL_BINARY_NAME
  return join(getNodeReplRootPath({ appIsPackaged, resourcesPath, desktopRoot }), 'bin', fileName)
}

export function getDesktopHostBinaryPath({
  appIsPackaged,
  resourcesPath,
  desktopRoot,
  platform = process.platform,
  arch = process.arch,
}) {
  if (platform !== 'win32' && platform !== 'darwin') {
    throw new Error(`unsupported desktop host target: ${platform}-${arch}`)
  }
  const targetId = getNativeTargetId({ platform, arch })
  const fileName = platform === 'win32'
    ? `${DESKTOP_HOST_BINARY_NAME}.exe`
    : DESKTOP_HOST_BINARY_NAME
  const root = appIsPackaged
    ? join(resourcesPath, 'desktop-host')
    : resolve(desktopRoot, 'resources', 'desktop-host')
  if (platform === 'darwin') {
    return join(root, targetId, DESKTOP_HOST_MAC_APP_NAME, 'Contents', 'MacOS', fileName)
  }
  return join(root, targetId, fileName)
}

export function createDesktopHostSpawnConfig({ binaryPath, endpoint, sessionToken, env = {}, platform = process.platform }) {
  if (platform === 'darwin') {
    return {
      command: '/usr/bin/open',
      args: [
        '-n',
        '-W',
        '-g',
        desktopHostMacAppPathFromExecutable(binaryPath),
        '--args',
        '--endpoint',
        endpoint,
      ],
      options: {
        env: { ...env, LUME_DESKTOP_HOST_TOKEN: sessionToken },
        stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    }
  }
  return {
    command: binaryPath,
    args: ['--endpoint', endpoint],
    options: {
      env: { ...env, LUME_DESKTOP_HOST_TOKEN: sessionToken },
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  }
}

function desktopHostMacAppPathFromExecutable(binaryPath: string): string {
  return dirname(dirname(dirname(binaryPath)))
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

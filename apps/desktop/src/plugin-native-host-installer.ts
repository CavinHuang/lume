import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, posix, win32 } from 'node:path'
import type { PluginSetupInstaller } from '../../../packages/shared/src/types/plugin-market'

export interface ChromeNativeHostInstallPlan {
  hostName: string
  hostPath: string
  configPath: string
  manifestPath: string
  hostConfig: Record<string, unknown>
  nativeManifest: Record<string, unknown>
  registry?: { command: string; args: string[] }
  platform: NodeJS.Platform
}

export function createChromeNativeHostInstallPlan(input: {
  installer: PluginSetupInstaller
  version: string
  configRoot: string
  homeDir: string
  localAppData?: string
  platform?: NodeJS.Platform
}): ChromeNativeHostInstallPlan {
  const platform = input.platform ?? process.platform
  const paths = platform === 'win32' ? win32 : posix
  const { installer } = input
  if (installer.kind !== 'chrome-native-host') throw new Error('unsupported plugin package installer')
  if (!/^(?=.{1,128}$)[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(installer.hostName)) {
    throw new Error('invalid native host name')
  }
  if (!/^[a-p]{32}$/.test(installer.extensionId)) throw new Error('invalid Chrome extension id')
  if (!isLoopbackWebSocketUrl(installer.appServerUrl)) throw new Error('native host app server must use a loopback WebSocket URL')
  if (!/^[0-9A-Za-z._-]{1,64}$/.test(input.version)) throw new Error('invalid native host version')
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
    throw new Error(`unsupported native host platform: ${platform}`)
  }

  const executableName = platform === 'win32' ? 'lume-chrome-host.exe' : 'lume-chrome-host'
  const installRoot = paths.join(input.configRoot, 'native-hosts', installer.hostName, input.version)
  const hostPath = paths.join(installRoot, executableName)
  const manifestRoot = platform === 'win32'
    ? paths.join(input.localAppData ?? paths.join(input.homeDir, 'AppData', 'Local'), 'Lume', 'ChromeNativeMessaging')
    : platform === 'darwin'
      ? paths.join(input.homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts')
      : paths.join(input.homeDir, '.config', 'google-chrome', 'NativeMessagingHosts')
  const manifestPath = paths.join(manifestRoot, `${installer.hostName}.json`)
  return {
    hostName: installer.hostName,
    hostPath,
    configPath: paths.join(installRoot, 'extension-host-config.json'),
    manifestPath,
    platform,
    hostConfig: {
      schemaVersion: 1,
      channel: 'release',
      extensionId: installer.extensionId,
      appServerUrl: installer.appServerUrl,
      appServerArgs: [],
    },
    nativeManifest: {
      name: installer.hostName,
      description: 'Lume Chrome native messaging host',
      path: hostPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${installer.extensionId}/`],
    },
    ...(platform === 'win32' ? {
      registry: {
        command: 'reg',
        args: [
          'add',
          `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${installer.hostName}`,
          '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f',
        ],
      },
    } : {}),
  }
}

export function writeChromeNativeHostRegistration(plan: ChromeNativeHostInstallPlan): void {
  mkdirSync(dirname(plan.hostPath), { recursive: true })
  mkdirSync(dirname(plan.manifestPath), { recursive: true })
  if (plan.platform !== 'win32') chmodSync(plan.hostPath, 0o755)
  writeFileSync(plan.configPath, `${JSON.stringify(plan.hostConfig, null, 2)}\n`, 'utf8')
  writeFileSync(plan.manifestPath, `${JSON.stringify(plan.nativeManifest, null, 2)}\n`, 'utf8')
}

function isLoopbackWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'ws:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  } catch {
    return false
  }
}

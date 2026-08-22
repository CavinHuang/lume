import { realpathSync, statSync } from 'node:fs'
import {
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PUBLIC_RENDERER_SIDECAR_METHODS } from './renderer-sidecar-methods'

// renderer IPC 命令/事件白名单与校验函数迁移至 renderer-ipc-contract.ts（与 preload 共享单源）
export {
  ALLOWED_RENDERER_INVOKE_COMMANDS,
  ALLOWED_RENDERER_EVENT_CHANNELS,
  validateRendererInvokeCommand,
  validateRendererEventChannel,
} from './renderer-ipc-contract'

export function validateRendererSidecarMethod(method) {
  if (typeof method !== 'string' || !method) throw new Error('invalid sidecar method')
  if (
    method.startsWith('plugin-package:privileged-')
    || method === 'system.privileged-credential'
    || method === 'agent:export-plugin-artifact'
    || method === 'agent:download-bridge-asset'
  ) {
    throw new Error('privileged RPC is not available through sidecar_call')
  }
  if (!PUBLIC_RENDERER_SIDECAR_METHODS.has(method)) {
    throw new Error(`unsupported renderer sidecar method: ${method}`)
  }
  return method
}

export function validateIpcSender(event, trustedWindows) {
  const windows = Array.isArray(trustedWindows) ? trustedWindows : [trustedWindows]
  const senders = windows
    .filter((win) => win && !win.isDestroyed?.())
    .map((win) => win.webContents)
  if (senders.length === 0) {
    throw new Error('no trusted window available')
  }
  if (!event || event.sender?.isDestroyed?.()) {
    throw new Error('untrusted ipc sender')
  }
  if (!senders.includes(event.sender)) {
    throw new Error('untrusted ipc sender')
  }
  return true
}

function normalizeFilePathUrl(url) {
  try {
    return fileURLToPath(url)
  } catch {
    return null
  }
}

export function isAllowedMainFrameNavigation(url, {
  appIsPackaged,
  appProtocolOrigin,
  devServerUrl,
  webEntryPath,
}) {
  try {
    const parsed = new URL(url)
    if (appIsPackaged) {
      if (appProtocolOrigin) {
        const allowed = new URL(appProtocolOrigin)
        return parsed.protocol === allowed.protocol && parsed.host === allowed.host
      }
      if (parsed.protocol !== 'file:' || !webEntryPath) return false
      return normalizeFilePathUrl(parsed.href) === webEntryPath
    }
    if (!devServerUrl) return false
    return parsed.origin === new URL(devServerUrl).origin
  } catch {
    return false
  }
}

export function resolveAppProtocolFilePath(url, webRoot, {
  scheme = 'lume:',
  host = 'app',
} = {}) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== scheme || parsed.host !== host || !webRoot) return null
    if (/%(?:00|2e|2f|5c)/i.test(url)) return null

    const decodedPath = decodeURIComponent(parsed.pathname)
    const normalizedRelativePath = normalize(
      decodedPath === '/' ? 'index.html' : decodedPath.replace(/^[/\\]+/, ''),
    )
    if (
      !normalizedRelativePath
      || normalizedRelativePath.includes('\0')
      || normalizedRelativePath === '..'
      || normalizedRelativePath.startsWith(`..\\`)
      || normalizedRelativePath.startsWith('../')
      || isAbsolute(normalizedRelativePath)
    ) {
      return null
    }

    const root = resolve(webRoot)
    const filePath = resolve(root, normalizedRelativePath)
    const relativeToRoot = relative(root, filePath)
    if (
      relativeToRoot === '..'
      || relativeToRoot.startsWith(`..\\`)
      || relativeToRoot.startsWith('../')
      || isAbsolute(relativeToRoot)
    ) {
      return null
    }
    return filePath
  } catch {
    return null
  }
}

export type FileProtocolResolution =
  | { kind: 'ok'; absPath: string }
  | { kind: 'forbidden' }
  | { kind: 'notfound' }

/**
 * 解析 lume-file:// 协议 URL 到可信绝对路径。
 * 四层校验：URL 编码攻击 → 白名单根 → UNC → symlink 逃逸（realpath）。
 * 返回 'forbidden'（越界/攻击）、'notfound'（不存在或非文件）、'ok'（可信绝对路径）。
 */
export function resolveFileProtocolPath(
  url: string,
  workspacesRoot: string,
): FileProtocolResolution {
  try {
    // 1) URL 编码层面的攻击（%00 NUL / %2e 编码的点防 .. 穿越）。
    //    不拦 %2f %5c：分隔符 `/` `\` 的合法编码（POSIX 上 encodeURIComponent('/')==='%2F'，
    //    Windows 上 encodeURIComponent('\\')==='%5C'），拦了会误伤所有合法绝对路径（跨平台失效）；
    //    真正的穿越由第 2 层白名单 + 第 4 层 realpath 兜底。
    if (/%(?:00|2e)/i.test(url)) return { kind: 'forbidden' }

    const parsed = new URL(url)
    const raw = `${parsed.hostname}${parsed.pathname}`.replace(/^\/+/, '')
    const abs = decodeURIComponent(
      raw.startsWith('file/') ? raw.slice('file/'.length) : raw,
    )
    const norm = resolve(abs)

    // 2) 白名单根
    const root = resolve(workspacesRoot)
    if (!isPathInsideRoot(norm, root)) return { kind: 'forbidden' }

    // 3) 禁 UNC（Windows）—— 冗余 defense-in-depth：合法 workspacesRoot 非 UNC，
    //    UNC 路径会被第 2 层 startsWith(root + sep) 白名单先拦，本层实际不可达，保留作兜底。
    if (sep === '\\' && norm.startsWith('\\\\')) return { kind: 'forbidden' }

    // 4) realpath 校验（防 symlink 逃逸）
    let real: string
    let realRoot: string
    try {
      realRoot = realpathSync(root)
      real = realpathSync(norm)
    } catch {
      return { kind: 'notfound' }
    }
    if (!isPathInsideRoot(real, realRoot)) return { kind: 'forbidden' }

    // 5) 必须是文件
    if (!statSync(real).isFile()) return { kind: 'notfound' }

    return { kind: 'ok', absPath: real }
  } catch {
    return { kind: 'forbidden' }
  }
}

function isPathInsideRoot(filePath: string, root: string): boolean {
  const relativePath = relative(root, filePath)
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
}

export function createWindowOpenAction(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return {
        action: 'deny',
        externalUrl: parsed.toString(),
      }
    }
  } catch {
    // Fall through to deny without delegation.
  }

  return {
    action: 'deny',
    externalUrl: null,
  }
}

export function createSecureWebPreferences(options: { preload?: string; webviewTag?: boolean } = {}) {
  return {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    ...(options.webviewTag === true ? { webviewTag: true } : {}),
    ...(options.preload ? { preload: options.preload } : {}),
  }
}

export { pathToFileURL }

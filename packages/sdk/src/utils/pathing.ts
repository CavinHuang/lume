import { access, readdir } from 'fs/promises'
import { resolve, isAbsolute, normalize, basename, dirname } from 'path'
import type { SandboxSettings } from '../types.js'

function normalizePath(path: string): string {
  return normalize(path).replace(/\\/g, '/').toLowerCase()
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function isPathWithinRoot(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path)
  const normalizedRoot = normalizePath(root)
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`)
  )
}

export function resolveCandidatePaths(
  cwd: string,
  inputPath: string,
  additionalDirectories: string[] = [],
): string[] {
  if (isAbsolute(inputPath)) {
    return [resolve(inputPath)]
  }

  return [cwd, ...additionalDirectories].map((base) => resolve(base, inputPath))
}

export function getUnsafeFilePathReason(inputPath: string): string | null {
  const normalized = inputPath.replace(/\\/g, '/')
  if (/^(?:\/\/|\\\\)[^/]+\/(?:[^/]+)?/.test(normalized)) {
    return 'UNC/SMB 路径默认禁止直接访问，避免意外泄露网络凭据。'
  }
  if (/^\/dev\//i.test(normalized)) {
    return '设备文件默认禁止通过 Read/Write/Edit 访问。'
  }
  if (/^\\\.\//.test(inputPath) || /^\\\\\.\\/.test(inputPath)) {
    return 'Windows 设备路径默认禁止通过 Read/Write/Edit 访问。'
  }
  return null
}

export async function suggestNearbyPaths(filePath: string, limit = 3): Promise<string[]> {
  try {
    const target = basename(filePath).toLowerCase()
    const parent = dirname(filePath)
    const entries = await readdir(parent, { withFileTypes: true })
    return entries
      .map((entry) => entry.name)
      .filter((name) => {
        const candidate = name.toLowerCase()
        return candidate.startsWith(target.slice(0, 2)) || candidate.includes(target.replace(/\.[^.]+$/, ''))
      })
      .sort((left, right) => left.length - right.length)
      .slice(0, limit)
      .map((name) => resolve(parent, name))
  } catch {
    return []
  }
}

export async function resolveInputPath(
  cwd: string,
  inputPath: string,
  additionalDirectories: string[] = [],
): Promise<string> {
  const candidates = resolveCandidatePaths(cwd, inputPath, additionalDirectories)
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate
    }
  }
  return candidates[0] || resolve(cwd, inputPath)
}

export function ensurePathAllowed(
  path: string,
  mode: 'read' | 'write',
  sandbox?: SandboxSettings,
  additionalDirectories: string[] = [],
): string | null {
  if (!sandbox?.enabled) return null

  const roots = additionalDirectories
  const fsRules = sandbox.filesystem

  if (mode === 'read') {
    if (fsRules?.denyRead?.some((root) => isPathWithinRoot(path, root))) {
      return `Sandbox denied read access to ${path}`
    }
    return null
  }

  if (fsRules?.denyWrite?.some((root) => isPathWithinRoot(path, root))) {
    return `Sandbox denied write access to ${path}`
  }

  if (fsRules?.allowWrite && fsRules.allowWrite.length > 0) {
    const allowedRoots = [...fsRules.allowWrite, ...roots]
    const allowed = allowedRoots.some((root) => isPathWithinRoot(path, root))
    if (!allowed) {
      return `Sandbox denied write access to ${path}`
    }
  }

  return null
}

export function getHostnameFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

export function ensureNetworkAllowed(
  url: string,
  sandbox?: SandboxSettings,
): string | null {
  if (!sandbox?.enabled || !sandbox.network) return null

  const hostname = getHostnameFromUrl(url)
  if (!hostname) return `Invalid URL: ${url}`

  const allowedDomains = sandbox.network.allowedDomains || []
  if (
    sandbox.network.allowManagedDomainsOnly ||
    allowedDomains.length > 0
  ) {
    const allowed = allowedDomains.some((domain) => {
      const normalizedDomain = domain.toLowerCase()
      return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`)
    })
    if (!allowed) {
      return `Sandbox denied network access to ${hostname}`
    }
  }

  return null
}

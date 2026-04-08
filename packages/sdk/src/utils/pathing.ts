import { access } from 'fs/promises'
import { resolve, isAbsolute, normalize } from 'path'
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


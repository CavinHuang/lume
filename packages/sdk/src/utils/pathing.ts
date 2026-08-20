import { access, readdir } from 'fs/promises'
import { resolve, isAbsolute, normalize, basename, dirname } from 'path'
import { isIP } from 'node:net'
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

/** 公网地址判定（自 sidecar wiki 服务移入单源维护）：拦截私网/回环/链路本地/CGNAT/基准测试等保留段。 */
export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const parts = address.split('.').map(Number)
    const [a, b] = parts
    if (a === 0 || a === 10 || a === 127 || a! >= 224) return false
    if (a === 100 && b! >= 64 && b! <= 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b! >= 16 && b! <= 31) return false
    if (a === 192 && (b === 0 || b === 168)) return false
    if (a === 198 && (b === 18 || b === 19)) return false
    return true
  }
  if (family === 6) {
    const value = address.toLowerCase().split('%')[0]!
    if (value === '::' || value === '::1') return false
    if (value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value)) return false
    if (value.startsWith('ff') || value.startsWith('2001:db8')) return false
    if (value.startsWith('::ffff:')) return isPublicIpAddress(value.slice(7))
    return true
  }
  return false
}

function isExplicitlyAllowedHost(hostname: string, sandbox?: SandboxSettings): boolean {
  const allowedDomains = sandbox?.network?.allowedDomains || []
  return allowedDomains.some((domain) => {
    const normalizedDomain = domain.toLowerCase()
    return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`)
  })
}

export function ensureNetworkAllowed(
  url: string,
  sandbox?: SandboxSettings,
): string | null {
  const hostname = getHostnameFromUrl(url)
  if (!hostname) {
    if (!sandbox?.enabled || !sandbox.network) return null
    return `Invalid URL: ${url}`
  }

  // 字面 IP 形式的私网/回环/链路本地地址一律拦截（防 SSRF 探测内网/云元数据端点），
  // 无论 sandbox 是否启用；用户在 allowedDomains 显式放行的 host 保留绕过路径。
  // 已知天花板：hostname 解析到私网地址的形态不在本函数覆盖（需要 DNS 判定，
  // 会破坏本地 fake-IP/离线解析环境），由 sidecar 注入的 fetchImpl 守卫收口。
  if (!isExplicitlyAllowedHost(hostname, sandbox)) {
    // Node 的 URL.hostname 对 IPv6 保留方括号（"[::1]"），剥掉再判
    const bare = hostname.replace(/^\[/, '').replace(/\]$/, '')
    if (isIP(bare) && !isPublicIpAddress(bare)) {
      return `Sandbox denied network access to ${hostname}`
    }
  }

  if (!sandbox?.enabled || !sandbox.network) return null

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

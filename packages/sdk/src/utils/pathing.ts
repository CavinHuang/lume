import { readdir, stat } from 'fs/promises'
import { existsSync, readlinkSync, realpathSync } from 'node:fs'
import { resolve, isAbsolute, normalize, basename, dirname } from 'path'
import { isIP } from 'node:net'
import type { SandboxSettings } from '../types.js'

function normalizePath(path: string): string {
  const normalized = normalize(path).replace(/\\/g, '/')
  // Fold case only on case-insensitive filesystems; on Linux the old unconditional
  // toLowerCase let ROOT-case variants of the root directory pass containment (#246)
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return normalized.toLowerCase()
  }
  return normalized
}

async function pathExists(path: string): Promise<boolean> {
  try {
    // 显式 follow 的 stat：Bun 的 access 对悬空 symlink 也返回成功，断链会被
    // 误判存在并解析到目标路径隐式创建文件；必须按不存在处理，交给写入侧报错
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Map/lock 键归一：win32/darwin 文件系统大小写不敏感，统一小写折叠，
 * 避免异写法路径绕过互斥或缓存命中（#334）。口径与 normalizePath 一致。
 */
export function toPathKey(path: string): string {
  const normalized = normalize(resolve(path)).replace(/\\/g, '/')
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return normalized.toLowerCase()
  }
  return normalized
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

/**
 * realpath 规范化（同步）：存在前缀做 realpathSync.native 解析，缺失尾部段
 * 原样拼回；悬空 symlink 的 existsSync 为 false 但链接本体仍按其目标解析，
 * 否则"经 symlink 写入尚不存在的外部目标"会绕过沙箱比对（#336）。
 */
export function canonicalizePath(input: string): string {
  let current = resolve(input)
  const tailSegments: string[] = []
  // 链跳上限防 symlink 环；超限按词法兜底（宁可漏判不挂死）
  for (let hop = 0; hop < 32; hop += 1) {
    if (existsSync(current)) {
      return resolve(realpathSync.native(current), ...tailSegments)
    }
    try {
      const linkTarget = readlinkSync(current)
      current = resolve(dirname(current), linkTarget)
      continue
    } catch {
      // 非 symlink 或不可读：当作缺失段向上走
    }
    const parent = dirname(current)
    if (parent === current) break
    tailSegments.unshift(basename(current))
    current = parent
  }
  return resolve(current, ...tailSegments)
}

export async function resolveInputPath(
  cwd: string,
  inputPath: string,
  additionalDirectories: string[] = [],
): Promise<string> {
  const candidates = resolveCandidatePaths(cwd, inputPath, additionalDirectories)
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      // 收口处 realpath：词法判定看不见 symlink 指向 deny 区的路径（#336）
      return canonicalizePath(candidate)
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

  // 目标与沙箱根都 canonicalize 后比对，symlink 指向 deny/allow 区外也能拦住（#336）。
  // # ponytail: 判定后仍存 check-then-use TOCTOU 天花板——路径可在判定后瞬间被
  // 替换成 symlink；根治需 fd 级 IO（openat2/RESOLVE_BENEATH）或打开后 fstat 复核，
  // 升级时把收口挪到各 tool 的文件句柄创建处。
  const canonicalPath = canonicalizePath(path)
  const within = (root: string): boolean => isPathWithinRoot(canonicalPath, canonicalizePath(root))

  const roots = additionalDirectories
  const fsRules = sandbox.filesystem

  if (mode === 'read') {
    if (fsRules?.denyRead?.some((root) => within(root))) {
      return `Sandbox denied read access to ${path}`
    }
    return null
  }

  if (fsRules?.denyWrite?.some((root) => within(root))) {
    return `Sandbox denied write access to ${path}`
  }

  if (fsRules?.allowWrite && fsRules.allowWrite.length > 0) {
    const allowedRoots = [...fsRules.allowWrite, ...roots]
    const allowed = allowedRoots.some((root) => within(root))
    if (!allowed) {
      return `Sandbox denied write access to ${path}`
    }
  }

  return null
}

/**
 * 写入 containment 复核，不以 sandbox.enabled 为前提（#546）：SDK 沙箱在
 * Lume 中恒未启用，ensurePathAllowed 首行即短路；junction/symlink 可穿越
 * 纯词法边界写到 workspace 外。canonicalize 后必须仍在 cwd ∪ additional
 * 目录内。sandbox 启用时的 deny/allow 规则仍由 ensurePathAllowed 叠加；
 * 若宿主配置 allowWrite 到 containment 根集之外，以本函数为准（取严）。
 */
export function ensureWriteContained(
  path: string,
  cwd: string,
  additionalDirectories: string[] = [],
): string | null {
  const canonical = canonicalizePath(path)
  const allowed = [cwd, ...additionalDirectories].some(
    (root) => isPathWithinRoot(canonical, canonicalizePath(root)),
  )
  return allowed ? null : `Write denied: ${path} resolves outside the workspace (configure permissions.privateWriteRoots to allow this directory)`
}

export function getHostnameFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** 公网地址判定（单源维护）：拦截私网/回环/链路本地/CGNAT/基准测试等保留段。 */
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

/**
 * fake-IP 段（198.18.0.0/15 基准测试保留段）判定：TUN 代理（Clash/sing-box fake-ip 模式）
 * 的 DNS 会把所有域名映射到该段，实际流量经代理出网，不指向任何真实内网。
 * DNS 解析后的判定用它豁免，避免代理环境下全域名被误判私网；字面 IP 守卫不豁免。
 */
export function isFakeIpRange(address: string): boolean {
  if (isIP(address) !== 4) return false
  const [a, b] = address.split('.').map(Number)
  return a === 198 && (b === 18 || b === 19)
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

import { createHash, randomBytes } from 'node:crypto'

const PLUGIN_ASSET_PROTOCOL_PREFIX = 'lume-file://plugin-asset/'
const DEFAULT_TTL_MS = 30 * 60 * 1000
const DEFAULT_MAX_ASSET_BYTES = 512 * 1024
const DEFAULT_MAX_OWNER_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024
const DATA_IMAGE_PATTERN = /^data:(image\/(?:png|jpeg|gif|webp|svg\+xml));base64,([A-Za-z0-9+/]*={0,2})$/i

export interface PluginAssetRecord {
  token: string
  ownerWebContentsId: number
  mediaType: string
  bytes: Buffer
  expiresAt: number
}

export interface PluginAssetRegistry {
  registerDataUrl(ownerWebContentsId: number, dataUrl: string): string
  owns(token: string, ownerWebContentsId: number): boolean
  get(token: string): PluginAssetRecord | undefined
  revokeOwner(ownerWebContentsId: number): void
}

export function pluginAssetTokenFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'lume-file:' || parsed.hostname !== 'plugin-asset') return undefined
    const token = parsed.pathname.slice(1)
    return /^[a-f0-9]{64}$/.test(token) ? token : undefined
  } catch {
    return undefined
  }
}

export function createPluginAssetRegistry(options: {
  now?: () => number
  ttlMs?: number
  maxAssetBytes?: number
  maxOwnerBytes?: number
  maxTotalBytes?: number
} = {}): PluginAssetRegistry {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const maxAssetBytes = options.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES
  const maxOwnerBytes = options.maxOwnerBytes ?? DEFAULT_MAX_OWNER_BYTES
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  const records = new Map<string, PluginAssetRecord & { digest: string }>()

  function cleanupExpired() {
    const current = now()
    for (const [token, record] of records) {
      if (record.expiresAt <= current) records.delete(token)
    }
  }

  function registerDataUrl(ownerWebContentsId: number, dataUrl: string): string {
    cleanupExpired()
    if (!Number.isSafeInteger(ownerWebContentsId) || ownerWebContentsId <= 0) throw new Error('invalid plugin asset owner')
    const match = DATA_IMAGE_PATTERN.exec(dataUrl)
    if (!match || match[2].length === 0 || match[2].length % 4 !== 0) throw new Error('invalid plugin image data URL')
    const bytes = Buffer.from(match[2], 'base64')
    if (bytes.length === 0 || bytes.length > maxAssetBytes || bytes.toString('base64') !== match[2]) {
      throw new Error('invalid plugin image payload')
    }
    const mediaType = match[1].toLowerCase()
    const digest = createHash('sha256').update(mediaType).update('\0').update(bytes).digest('hex')
    const existing = [...records.values()].find(
      (record) => record.ownerWebContentsId === ownerWebContentsId && record.digest === digest,
    )
    if (existing) {
      existing.expiresAt = now() + ttlMs
      return `${PLUGIN_ASSET_PROTOCOL_PREFIX}${existing.token}`
    }
    let ownerBytes = 0
    let totalBytes = 0
    for (const record of records.values()) {
      totalBytes += record.bytes.length
      if (record.ownerWebContentsId === ownerWebContentsId) ownerBytes += record.bytes.length
    }
    if (ownerBytes + bytes.length > maxOwnerBytes || totalBytes + bytes.length > maxTotalBytes) {
      throw new Error('plugin asset quota exceeded')
    }
    const token = randomBytes(32).toString('hex')
    records.set(token, {
      token,
      ownerWebContentsId,
      mediaType,
      bytes,
      expiresAt: now() + ttlMs,
      digest,
    })
    return `${PLUGIN_ASSET_PROTOCOL_PREFIX}${token}`
  }

  function get(token: string): PluginAssetRecord | undefined {
    cleanupExpired()
    return records.get(token)
  }

  return {
    registerDataUrl,
    get,
    owns(token, ownerWebContentsId) {
      return get(token)?.ownerWebContentsId === ownerWebContentsId
    },
    revokeOwner(ownerWebContentsId) {
      for (const [token, record] of records) {
        if (record.ownerWebContentsId === ownerWebContentsId) records.delete(token)
      }
    },
  }
}

const PLUGIN_ASSET_RESULT_METHODS = new Set([
  'agent:get-market-catalog',
  'agent:get-market-detail',
  'agent:list-invocable-capabilities',
])

export function scopePluginAssetUrls(
  registry: PluginAssetRegistry,
  method: string,
  value: unknown,
  ownerWebContentsId: number,
): unknown {
  if (!PLUGIN_ASSET_RESULT_METHODS.has(method)) return value
  if (typeof value === 'string') {
    if (!value.startsWith('data:image/')) return value
    try {
      return registry.registerDataUrl(ownerWebContentsId, value)
    } catch {
      return null
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => scopePluginAssetUrls(registry, method, item, ownerWebContentsId))
  }
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      scopePluginAssetUrls(registry, method, item, ownerWebContentsId),
    ]),
  )
}

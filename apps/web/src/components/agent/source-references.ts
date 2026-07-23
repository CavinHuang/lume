import type { RuntimeAssistantBlock, RuntimeToolCallView } from './runtime-message-view'

export interface AssistantSourceReference {
  url: string
  title: string
  domain: string
  clickable: boolean
}

export interface AssistantSourceCollection {
  sources: AssistantSourceReference[]
  truncated: boolean
}

const MAX_SOURCES_PER_TOOL = 32
const MAX_SOURCES_PER_REPLY = 128
const MAX_SOURCE_METADATA_CHARS = 32 * 1024
const SENSITIVE_QUERY_KEY = /(?:token|secret|password|passwd|api[_-]?key|access[_-]?token|auth|session|jwt|signature|sig|code)/i

export function collectAssistantSources(blocks: RuntimeAssistantBlock[]): AssistantSourceCollection {
  const sources: AssistantSourceReference[] = []
  const seen = new Set<string>()
  let truncated = false

  for (const block of blocks) {
    if (block.type !== 'tool_call') continue
    const extracted = extractToolCallSources(block.toolCall)
    truncated ||= extracted.truncated
    for (const source of extracted.sources) {
      const key = canonicalizeSourceUrl(source.url)
      if (!key || seen.has(key)) continue
      if (sources.length >= MAX_SOURCES_PER_REPLY || estimateSourceChars(sources) + estimateSourceChars([source]) > MAX_SOURCE_METADATA_CHARS) {
        truncated = true
        continue
      }
      seen.add(key)
      sources.push(source)
    }
  }

  return { sources, truncated }
}

export function extractToolCallSources(toolCall: RuntimeToolCallView): AssistantSourceCollection {
  if (toolCall.status !== 'completed' || toolCall.isError) return { sources: [], truncated: false }

  const toolName = normalizeToolName(toolCall.toolName)
  if (toolName === 'webfetch') {
    const input = asRecord(toolCall.input)
    const source = typeof input?.url === 'string' ? makeSource(input.url) : null
    return { sources: source ? [source] : [], truncated: false }
  }
  if (toolName !== 'websearch') return { sources: [], truncated: false }

  const payload = parseJson(toolCall.output)
  const items = extractSearchItems(payload)
  const sources: AssistantSourceReference[] = []
  const seen = new Set<string>()
  let truncated = false
  for (const item of items) {
    const source = makeSource(readString(item.url ?? item.link), readString(item.title ?? item.name))
    if (!source) continue
    const key = canonicalizeSourceUrl(source.url)
    if (!key || seen.has(key)) continue
    if (sources.length >= MAX_SOURCES_PER_TOOL) {
      truncated = true
      continue
    }
    seen.add(key)
    sources.push(source)
  }
  return { sources, truncated }
}

function normalizeToolName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function extractSearchItems(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(isRecord)
  const record = asRecord(value)
  if (!record) return []
  if (Array.isArray(record.results)) return record.results.filter(isRecord)
  if (Array.isArray(record.data)) return record.data.filter(isRecord)
  const data = asRecord(record.data)
  if (Array.isArray(data?.results)) return data.results.filter(isRecord)
  return []
}

function makeSource(rawUrl: string | undefined, rawTitle?: string): AssistantSourceReference | null {
  if (!rawUrl) return null
  const parsed = parseHttpUrl(rawUrl)
  if (!parsed) return null
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) parsed.searchParams.delete(key)
  }
  parsed.username = ''
  parsed.password = ''
  const url = parsed.href
  if (!/^https?:\/\//i.test(url)) return null
  const domain = parsed.hostname
  return {
    url,
    title: rawTitle?.trim() || domain,
    domain,
    clickable: !isLocalOrPrivateHost(domain),
  }
}

function parseHttpUrl(value: string): URL | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const normalized = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(normalized)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url
  } catch {
    return null
  }
}

function canonicalizeSourceUrl(value: string): string | null {
  const parsed = parseHttpUrl(value)
  if (!parsed) return null
  parsed.hash = ''
  if (parsed.pathname === '/') parsed.pathname = ''
  return parsed.href.replace(/\/$/, '')
}

function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true
  const private172 = host.match(/^172\.(\d+)\./)
  return Boolean(private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31)
}

function estimateSourceChars(sources: AssistantSourceReference[]): number {
  return sources.reduce((sum, source) => sum + source.url.length + source.title.length + source.domain.length, 0)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

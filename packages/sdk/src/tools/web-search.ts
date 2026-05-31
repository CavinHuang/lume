/**
 * WebSearchTool - Web search with provider fallback
 */

import { spawn } from 'node:child_process'
import { defineTool } from './types.js'
import { ensureNetworkAllowed } from '../utils/pathing.js'
import { sdkFetch } from './web-request.js'

export interface SearchResult {
  title: string
  url: string
  snippet?: string
  content?: string
}

type WebSearchProviderName =
  | 'guanlan'
  | 'exa'
  | 'pipellm'
  | 'zhipu'
  | 'tavily'
  | 'brave'
  | 'duckduckgo'
  | 'bing'

const DEFAULT_PROVIDER_ORDER: WebSearchProviderName[] = [
  'guanlan',
  'exa',
  'pipellm',
  'zhipu',
  'tavily',
  'brave',
  'duckduckgo',
  'bing',
]

const PROVIDER_NAMES = new Set<WebSearchProviderName>(DEFAULT_PROVIDER_ORDER)

// ─── HTML content cleaning pipeline ───────────────────────────

const NOISE_SELECTORS = [
  /<nav[\s>][\s\S]*?<\/nav>/gi,
  /<footer[\s>][\s\S]*?<\/footer>/gi,
  /<header[\s>][\s\S]*?<\/header>/gi,
  /<aside[\s>][\s\S]*?<\/aside>/gi,
  /<form[\s>][\s\S]*?<\/form>/gi,
  /<noscript[\s>][\s\S]*?<\/noscript>/gi,
  /<iframe[\s>][\s\S]*?<\/iframe>/gi,
  /<style[\s>][\s\S]*?<\/style>/gi,
  /<script[\s>][\s\S]*?<\/script>/gi,
  /<svg[\s>][\s\S]*?<\/svg>/gi,
  /<!--[\s\S]*?-->/g,
]

const WHITESPACE = /[ \t]+/g
const MULTI_NEWLINES = /\n{3,}/g

function extractMainContent(html: string): string {
  let text = html

  // Strip <head> entirely
  text = text.replace(/<head[\s>][\s\S]*?<\/head>/gi, '')

  // Strip noise sections
  for (const pattern of NOISE_SELECTORS) {
    text = text.replace(pattern, ' ')
  }

  // Try to find <main> or <article> if present
  const mainMatch = /<(?:main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i.exec(text)
  if (mainMatch?.[1]) {
    text = mainMatch[1]
  }

  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, ' ')

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')

  // Collapse whitespace
  text = text.replace(WHITESPACE, ' ').replace(MULTI_NEWLINES, '\n\n').trim()

  return text
}

function truncateContent(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const truncated = text.slice(0, maxChars)
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('。'),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('？'),
    truncated.lastIndexOf('\n')
  )
  if (lastSentenceEnd > maxChars * 0.5) {
    return truncated.slice(0, lastSentenceEnd + 1).trimEnd() + '…'
  }
  return truncated.trimEnd() + '…'
}

const MAX_CONTENT_CHARS = 1500
const MAX_CONCURRENT_FETCHES = 3
const GUANLAN_TIMEOUT_MS = 20000
const MAX_GUANLAN_STDERR_CHARS = 2000
const MAX_GUANLAN_STDOUT_CHARS = 200000

async function fetchPageContent(
  url: string,
  sandbox: unknown
): Promise<string | null> {
  const sandboxError = ensureNetworkAllowed(url, sandbox as never)
  if (sandboxError) return null
  try {
    const response = await sdkFetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) return null
    const html = await response.text()
    const cleaned = extractMainContent(html)
    return truncateContent(cleaned, MAX_CONTENT_CHARS)
  } catch {
    return null
  }
}

async function enrichResultsWithContent(
  results: SearchResult[],
  sandbox: unknown
): Promise<SearchResult[]> {
  const toFetch = results.filter((r) => !r.content || r.content.length < 50)
  if (toFetch.length === 0) return results

  const enriched = new Map<string, string | null | undefined>()

  // Fetch in batches of MAX_CONCURRENT_FETCHES
  for (let i = 0; i < toFetch.length; i += MAX_CONCURRENT_FETCHES) {
    const batch = toFetch.slice(i, i + MAX_CONCURRENT_FETCHES)
    const contents = await Promise.all(
      batch.map((r) => fetchPageContent(r.url, sandbox))
    )
    batch.forEach((r, j) => enriched.set(r.url, contents[j]))
  }

  return results.map((r) => {
    const content = enriched.get(r.url) ?? null
    return content ? { ...r, content } : r
  })
}

// ─── Result formatting ────────────────────────────────────────

function formatResults(results: SearchResult[], query: string): string {
  if (results.length === 0) return `No results found for "${query}".`
  const parts = results.map((r, i) => {
    const parts = [`[${i + 1}] ${r.title}`, `    URL: ${r.url}`]
    if (r.snippet) parts.push(`    ${r.snippet}`)
    if (r.content) parts.push(`    Content: ${r.content}`)
    return parts.join('\n')
  })
  return `Search results for "${query}":\n\n${parts.join('\n\n')}`
}

// ─── API key helpers ──────────────────────────────────────────

function getEnvKey(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return undefined
}

export function resolveEnabledWebSearchProviders(envValue = process.env.LUME_WEB_SEARCH_PROVIDERS): WebSearchProviderName[] {
  if (envValue === undefined) return [...DEFAULT_PROVIDER_ORDER]
  return envValue
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item): item is WebSearchProviderName => PROVIDER_NAMES.has(item as WebSearchProviderName))
}

// ─── Search providers ─────────────────────────────────────────

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

async function runCommand(command: string, args: string[], timeoutMs = GUANLAN_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
      },
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      resolve({ code: 124, stdout, stderr: stderr || 'command timed out' })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout = truncateRawText(stdout + chunk.toString('utf8'), MAX_GUANLAN_STDOUT_CHARS)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = truncateRawText(stderr + chunk.toString('utf8'), MAX_GUANLAN_STDERR_CHARS)
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      resolve({ code: 127, stdout, stderr: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      resolve({ code: code ?? 0, stdout, stderr })
    })
  })
}

export function truncateRawText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...(truncated)` : text
}

export function parseGuanlanSearchOutput(output: string): SearchResult[] {
  let payload: unknown
  try {
    payload = JSON.parse(output)
  } catch {
    return []
  }
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { results?: unknown[] } | null)?.results)
      ? (payload as { results: unknown[] }).results
      : []

  return items
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const record = item as Record<string, unknown>
      const title = readResultString(record.title) || readResultString(record.name)
      const url = readResultString(record.url) || readResultString(record.link)
      if (!title || !url) return null
      const snippet = readResultString(record.snippet) || readResultString(record.content)
      return { title, url, ...(snippet ? { snippet } : {}) }
    })
    .filter((item): item is SearchResult => !!item)
}

function readResultString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function clampProviderLimit(numResults: number): number {
  return Math.max(1, Math.min(Math.trunc(numResults || 5), 10))
}

export async function runGuanlanPython(args: string[], timeoutMs = GUANLAN_TIMEOUT_MS): Promise<CommandResult> {
  const configuredPython = process.env.LUME_GUANLAN_PYTHON?.trim()
  if (configuredPython) return runCommand(configuredPython, args, timeoutMs)

  const first = await runCommand('python3', args, timeoutMs)
  if (first.code !== 127) return first
  return runCommand('python', args, timeoutMs)
}

async function searchWithGuanlan(query: string, numResults: number) {
  if (process.env.LUME_GUANLAN_ENABLED !== '1') return null
  const result = await runGuanlanPython([
    '-m',
    'guanlan',
    'search',
    query,
    '--profile',
    'china',
    '--limit',
    String(clampProviderLimit(numResults)),
    '--json',
  ])
  if (result.code !== 0) {
    throw new Error(`Guanlan search failed: ${truncateRawText(result.stderr || result.stdout, MAX_GUANLAN_STDERR_CHARS)}`)
  }
  return { data: parseGuanlanSearchOutput(result.stdout), is_error: false } as const
}

function decodeDuckDuckGoRedirectUrl(rawUrl: string): string {
  const normalized = rawUrl.replace(/&amp;/gi, '&')
  const index = normalized.indexOf('uddg=')
  if (index < 0) return normalized
  const encoded = normalized.slice(index + 5).split('&')[0] ?? ''
  try {
    return decodeURIComponent(encoded)
  } catch {
    return normalized
  }
}

async function searchWithBrave(query: string, numResults: number, sandbox: unknown) {
  const apiKey = getEnvKey(['BRAVE_API_KEY', 'LUME_BRAVE_API_KEY'])
  if (!apiKey) return null
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.max(1, Math.min(numResults || 5, 10))}`
  const sandboxError = ensureNetworkAllowed(url, sandbox as never)
  if (sandboxError) return { data: sandboxError, is_error: true } as const
  const response = await sdkFetch(url, {
    headers: { 'x-subscription-token': apiKey, accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`Brave search failed: HTTP ${response.status}`)
  const payload = await response.json() as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> }
  }
  const results = (payload.web?.results ?? [])
    .map((item) => ({ title: item.title ?? '', url: item.url ?? '', snippet: item.description ?? '' }))
    .filter((item) => item.title && item.url)
  return { data: results, is_error: false } as const
}

async function searchWithTavily(query: string, numResults: number, sandbox: unknown) {
  const apiKey = getEnvKey(['TAVILY_API_KEY', 'LUME_TAVILY_API_KEY'])
  if (!apiKey) return null
  const url = 'https://api.tavily.com/search'
  const sandboxError = ensureNetworkAllowed(url, sandbox as never)
  if (sandboxError) return { data: sandboxError, is_error: true } as const
  const response = await sdkFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey, query, search_depth: 'basic',
      max_results: Math.max(1, Math.min(numResults || 5, 10)),
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`Tavily search failed: HTTP ${response.status}`)
  const payload = await response.json() as {
    results?: Array<{ title?: string; url?: string; content?: string }>
  }
  const results = (payload.results ?? [])
    .map((item) => ({ title: item.title ?? '', url: item.url ?? '', snippet: item.content ?? '' }))
    .filter((item) => item.title && item.url)
  return { data: results, is_error: false } as const
}

async function searchWithExa(query: string, numResults: number, sandbox: unknown) {
  const apiKey = getEnvKey(['EXA_API_KEY', 'LUME_EXA_API_KEY'])
  if (!apiKey) return null
  const url = 'https://api.exa.ai/search'
  const sandboxError = ensureNetworkAllowed(url, sandbox as never)
  if (sandboxError) return { data: sandboxError, is_error: true } as const
  const response = await sdkFetch(url, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      query, type: 'auto',
      numResults: Math.max(1, Math.min(numResults || 5, 10)),
      contents: { text: { maxCharacters: 1000 } },
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`Exa search failed: HTTP ${response.status}`)
  const payload = await response.json() as {
    results?: Array<{ title?: string; url?: string; text?: string }>
  }
  const results = (payload.results ?? [])
    .map((item) => ({
      title: item.title ?? '', url: item.url ?? '',
      snippet: '', content: item.text ? truncateContent(item.text, MAX_CONTENT_CHARS) : undefined,
    }))
    .filter((item) => item.title && item.url)
  return { data: results, is_error: false } as const
}

async function searchWithPipellm(query: string, numResults: number, sandbox: unknown) {
  const apiKey = getEnvKey(['PIPELLM_API_KEY', 'LUME_PIPELLM_API_KEY'])
  if (!apiKey) return null
  const url = 'https://api.pipellm.com/v1/search'
  const sandboxError = ensureNetworkAllowed(url, sandbox as never)
  if (sandboxError) return { data: sandboxError, is_error: true } as const
  const response = await sdkFetch(url, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, max_results: Math.max(1, Math.min(numResults || 5, 10)) }),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`PipeLLM search failed: HTTP ${response.status}`)
  const payload = await response.json() as {
    results?: Array<{ title?: string; url?: string; snippet?: string }>
  }
  const results = (payload.results ?? [])
    .map((item) => ({ title: item.title ?? '', url: item.url ?? '', snippet: item.snippet ?? '' }))
    .filter((item) => item.title && item.url)
  return { data: results, is_error: false } as const
}

async function searchWithZhipu(query: string, numResults: number, sandbox: unknown) {
  const apiKey = getEnvKey(['ZHIPU_API_KEY', 'LUME_ZHIPU_API_KEY'])
  if (!apiKey) return null
  const url = 'https://open.bigmodel.cn/api/paas/v4/web_search'
  const sandboxError = ensureNetworkAllowed(url, sandbox as never)
  if (sandboxError) return { data: sandboxError, is_error: true } as const
  const response = await sdkFetch(url, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, count: Math.max(1, Math.min(numResults || 5, 10)) }),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`Zhipu search failed: HTTP ${response.status}`)
  const payload = await response.json() as {
    data?: Array<{ title?: string; link?: string; content?: string; snippet?: string }>
  }
  const results = (payload.data ?? [])
    .map((item) => ({
      title: item.title ?? '', url: item.link ?? '',
      snippet: item.snippet ?? '',
      content: item.content ? truncateContent(item.content, MAX_CONTENT_CHARS) : undefined,
    }))
    .filter((item) => item.title && item.url)
  return { data: results, is_error: false } as const
}

async function searchWithDuckDuckGo(query: string, numResults: number, sandbox: unknown) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const sandboxError = ensureNetworkAllowed(url, sandbox as never)
  if (sandboxError) return { data: sandboxError, is_error: true } as const
  const response = await sdkFetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentSDK/1.0)' },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`DuckDuckGo search failed: HTTP ${response.status}`)

  const html = await response.text()
  const resultRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippetRegex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi

  let match: RegExpExecArray | null
  const links: Array<{ title: string; url: string }> = []
  while ((match = resultRegex.exec(html)) !== null) {
    const href = decodeDuckDuckGoRedirectUrl(match[1] ?? '')
    const rawTitle = match[2]
    if (!rawTitle) continue
    const title = rawTitle.replace(/<[^>]+>/g, '').trim()
    if (href && title) links.push({ title, url: href })
  }
  const snippets: string[] = []
  while ((match = snippetRegex.exec(html)) !== null) {
    const rawSnippet = match[1]
    if (!rawSnippet) continue
    snippets.push(rawSnippet.replace(/<[^>]+>/g, '').trim())
  }

  const results: SearchResult[] = []
  const limit = Math.min(numResults || 5, links.length)
  for (let i = 0; i < limit; i++) {
    const link = links[i]
    if (!link) continue
    results.push({ title: link.title, url: link.url, snippet: snippets[i] })
  }
  return { data: results, is_error: false } as const
}

async function searchWithBing(query: string, numResults: number, sandbox: unknown) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
  const sandboxError = ensureNetworkAllowed(url, sandbox as never)
  if (sandboxError) return { data: sandboxError, is_error: true } as const
  const response = await sdkFetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`Bing search failed: HTTP ${response.status}`)

  const html = await response.text()
  const results: SearchResult[] = []
  const liRegex = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi
  let liMatch: RegExpExecArray | null
  while ((liMatch = liRegex.exec(html)) !== null) {
    if (results.length >= (numResults || 5)) break
    const block = liMatch[1]
    if (!block) continue
    const hrefMatch = /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!hrefMatch) continue
    const rawUrl = hrefMatch[1]
    const rawTitle = hrefMatch[2]
    if (!rawUrl || !rawTitle) continue
    const title = rawTitle.replace(/<[^>]+>/g, '').trim()
    if (!title) continue
    const snippetMatch = /<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/i.exec(block)
    const snippet = snippetMatch ? snippetMatch[1]?.replace(/<[^>]+>/g, '').trim() ?? '' : ''
    results.push({ title, url: rawUrl, snippet })
  }
  return { data: results, is_error: false } as const
}

// ─── Tool definition ──────────────────────────────────────────

export const WebSearchTool = defineTool({
  name: 'WebSearch',
  description: 'Search the web for information. Returns search results with titles, URLs, snippets, and extracted page content.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      num_results: {
        type: 'number',
        description: 'Number of results to return (default: 5)',
      },
    },
    required: ['query'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context) {
    const { query } = input

    try {
      const numResults = typeof input.num_results === 'number' ? input.num_results : 5
      const providerAttempts: Record<WebSearchProviderName, () => Promise<unknown>> = {
        guanlan: () => searchWithGuanlan(query, numResults),
        exa: () => searchWithExa(query, numResults, context.sandbox),
        pipellm: () => searchWithPipellm(query, numResults, context.sandbox),
        zhipu: () => searchWithZhipu(query, numResults, context.sandbox),
        tavily: () => searchWithTavily(query, numResults, context.sandbox),
        brave: () => searchWithBrave(query, numResults, context.sandbox),
        duckduckgo: () => searchWithDuckDuckGo(query, numResults, context.sandbox),
        bing: () => searchWithBing(query, numResults, context.sandbox),
      }
      const attempts = resolveEnabledWebSearchProviders()
        .map((provider) => providerAttempts[provider])

      let rawResults: SearchResult[] | null = null
      let lastError: unknown = null

      for (const attempt of attempts) {
        try {
          const result = await attempt()
          if (isSearchProviderResult(result) && result.is_error !== true) {
            rawResults = result.data
            if (rawResults && rawResults.length > 0) break
          }
        } catch (error) {
          lastError = error
        }
      }

      if (!rawResults || rawResults.length === 0) {
        throw lastError ?? new Error('No search provider available')
      }

      // Enrich results without content by fetching pages
      const needsEnrichment = rawResults.some((r) => !r.content || r.content.length < 50)
      const enriched = needsEnrichment
        ? await enrichResultsWithContent(rawResults.slice(0, numResults), context.sandbox)
        : rawResults

      return { data: formatResults(enriched, query) }
    } catch (err: any) {
      return { data: `Search error: ${err.message}`, is_error: true }
    }
  },
})

function isSearchProviderResult(value: unknown): value is { data: SearchResult[]; is_error?: boolean } {
  return !!value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)
}

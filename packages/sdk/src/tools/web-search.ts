/**
 * WebSearchTool - Web search with provider fallback
 */

import { defineTool } from './types.js'
import { ensureNetworkAllowed } from '../utils/pathing.js'
import { sdkFetch } from './web-request.js'
import { loadPage } from './web-fetch-http.js'

export interface SearchResult {
  title: string
  url: string
  snippet?: string
  content?: string
}

export type WebSearchProviderName =
  | 'exa'
  | 'pipellm'
  | 'zhipu'
  | 'tavily'
  | 'brave'
  | 'duckduckgo'
  | 'bing'

const DEFAULT_PROVIDER_ORDER: WebSearchProviderName[] = [
  'exa',
  'pipellm',
  'zhipu',
  'tavily',
  'brave',
  'duckduckgo',
  'bing',
]

export const ENGINE_TIMEOUT_MS: Record<WebSearchProviderName, number> = {
  exa: 15000,
  pipellm: 15000,
  zhipu: 20000,
  tavily: 30000,
  brave: 10000,
  duckduckgo: 15000,
  bing: 10000,
}

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
const MAX_PAGE_FETCH_BYTES = 5 * 1024 * 1024
const MAX_CONCURRENT_FETCHES = 3

/**
 * Combine the caller's abort signal with the provider's fixed timeout so a
 * user cancellation cuts through every provider request (#343).
 */
function requestSignal(userSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!userSignal || userSignal.aborted) return userSignal ?? timeoutSignal
  return typeof AbortSignal.any === 'function'
    ? AbortSignal.any([userSignal, timeoutSignal])
    : timeoutSignal
}

export async function fetchPageContent(
  url: string,
  sandbox: unknown,
  signal?: AbortSignal
): Promise<string | null> {
  if (signal?.aborted) return null
  // loadPage enforces the sandbox check and a byte cap on the response body.
  const result = await loadPage(url, {
    fetchImpl: sdkFetch,
    timeoutMs: 8000,
    maxBytes: MAX_PAGE_FETCH_BYTES,
    signal,
    sandbox: sandbox as never,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  })
  if (!result.ok) return null
  const cleaned = extractMainContent(result.content)
  return truncateContent(cleaned, MAX_CONTENT_CHARS)
}

export async function enrichResultsWithContent(
  results: SearchResult[],
  sandbox: unknown,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const toFetch = results.filter((r) => !r.content || r.content.length < 50)
  if (toFetch.length === 0) return results

  const enriched = new Map<string, string | null | undefined>()

  // Fetch in batches of MAX_CONCURRENT_FETCHES, bailing out once aborted.
  for (let i = 0; i < toFetch.length && !signal?.aborted; i += MAX_CONCURRENT_FETCHES) {
    const batch = toFetch.slice(i, i + MAX_CONCURRENT_FETCHES)
    const contents = await Promise.all(
      batch.map((r) => fetchPageContent(r.url, sandbox, signal))
    )
    batch.forEach((r, j) => enriched.set(r.url, contents[j]))
  }

  return results.map((r) => {
    const content = enriched.get(r.url) ?? null
    return content ? { ...r, content } : r
  })
}

// ─── Result formatting ────────────────────────────────────────

export function formatResults(results: SearchResult[], query: string): string {
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

export function clampProviderLimit(numResults: number): number {
  return Math.max(1, Math.min(Math.trunc(numResults || 5), 10))
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

async function searchWithBrave(query: string, numResults: number, sandbox: unknown, signal?: AbortSignal) {
  const apiKey = getEnvKey(['BRAVE_API_KEY', 'LUME_BRAVE_API_KEY'])
  if (!apiKey) return null
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.max(1, Math.min(numResults || 5, 10))}`
  const sandboxError = ensureNetworkAllowed(url, sandbox as never)
  if (sandboxError) return { data: sandboxError, is_error: true } as const
  const response = await sdkFetch(url, {
    headers: { 'x-subscription-token': apiKey, accept: 'application/json' },
    signal: requestSignal(signal, ENGINE_TIMEOUT_MS.brave),
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

async function searchWithTavily(query: string, numResults: number, sandbox: unknown, signal?: AbortSignal) {
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
    signal: requestSignal(signal, ENGINE_TIMEOUT_MS.tavily),
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

async function searchWithExa(query: string, numResults: number, sandbox: unknown, signal?: AbortSignal) {
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
    signal: requestSignal(signal, ENGINE_TIMEOUT_MS.exa),
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

async function searchWithPipellm(query: string, numResults: number, sandbox: unknown, signal?: AbortSignal) {
  const apiKey = getEnvKey(['PIPELLM_API_KEY', 'LUME_PIPELLM_API_KEY'])
  if (!apiKey) return null
  const url = 'https://api.pipellm.com/v1/search'
  const sandboxError = ensureNetworkAllowed(url, sandbox as never)
  if (sandboxError) return { data: sandboxError, is_error: true } as const
  const response = await sdkFetch(url, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, max_results: Math.max(1, Math.min(numResults || 5, 10)) }),
    signal: requestSignal(signal, ENGINE_TIMEOUT_MS.pipellm),
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

async function searchWithZhipu(query: string, numResults: number, sandbox: unknown, signal?: AbortSignal) {
  const apiKey = getEnvKey(['ZHIPU_API_KEY', 'LUME_ZHIPU_API_KEY'])
  if (!apiKey) return null
  const url = 'https://open.bigmodel.cn/api/paas/v4/web_search'
  const sandboxError = ensureNetworkAllowed(url, sandbox as never)
  if (sandboxError) return { data: sandboxError, is_error: true } as const
  const response = await sdkFetch(url, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, count: Math.max(1, Math.min(numResults || 5, 10)) }),
    signal: requestSignal(signal, ENGINE_TIMEOUT_MS.zhipu),
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

async function searchWithDuckDuckGo(query: string, numResults: number, sandbox: unknown, signal?: AbortSignal) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const sandboxError = ensureNetworkAllowed(url, sandbox as never)
  if (sandboxError) return { data: sandboxError, is_error: true } as const
  const response = await sdkFetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentSDK/1.0)' },
    signal: requestSignal(signal, ENGINE_TIMEOUT_MS.duckduckgo),
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

export function detectAcceptLanguage(query: string): string {
  if (/[가-힣ᄀ-ᇿ㄰-㆏]/.test(query))
    return "ko-KR,ko;q=0.9,en;q=0.8";
  if (/[぀-ヿㇰ-ㇿ]/.test(query))
    return "ja-JP,ja;q=0.9,en;q=0.8";
  if (/[؀-ۿ]/.test(query))
    return "ar-SA,ar;q=0.9,en;q=0.8";
  if (/[Ѐ-ӿ]/.test(query))
    return "ru-RU,ru;q=0.9,en;q=0.8";
  if (/[一-鿿㐀-䶿]/.test(query))
    return "zh-CN,zh;q=0.9,en;q=0.8";
  return "en-US,en;q=0.9";
}

const BING_BLOCK_PATTERNS = ["unusual traffic", "captcha", "blocked", "<某>"];

export function isBingBlockedPage(html: string): boolean {
  const lower = html.toLowerCase();
  return BING_BLOCK_PATTERNS.some((p) => lower.includes(p));
}

export function parseBingResultItem(itemHtml: string): SearchResult | null {
  const titleMatch = itemHtml.match(
    /<h2[^>]*>[\s\S]*?<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i
  );
  if (!titleMatch) return null;
  const url = titleMatch[1] ?? "";
  const title = (titleMatch[2] ?? "").replace(/<[^>]+>/g, "").trim();
  if (!title || !url) return null;

  let snippet = "";
  const snipMatch =
    itemHtml.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ??
    itemHtml.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
  if (snipMatch) snippet = (snipMatch[1] ?? "").replace(/<[^>]+>/g, "").trim();

  return { title, url, snippet: snippet || undefined };
}

async function searchWithBing(query: string, numResults: number, sandbox: unknown, signal?: AbortSignal) {
  const lang = detectAcceptLanguage(query);
  const hosts = ["cn.bing.com", "www.bing.com"] as const;
  let html = "";

  for (const host of hosts) {
    const url = `https://${host}/search?q=${encodeURIComponent(query)}&count=${Math.min(numResults, 20)}`;
    const sandboxError = ensureNetworkAllowed(url, sandbox as never);
    if (sandboxError) return { data: sandboxError, is_error: true } as const;
    const response = await sdkFetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": lang,
      },
      signal: requestSignal(signal, 10000),
      redirect: "follow",
    });
    if (response.ok) {
      const body = await response.text();
      if (body.includes("b_algo") && !isBingBlockedPage(body)) {
        html = body;
        break;
      }
    }
  }

  if (!html) throw new Error("Bing search failed: no results from any host");

  const results: SearchResult[] = [];
  const algoRegex = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;
  while ((match = algoRegex.exec(html)) !== null) {
    if (results.length >= numResults) break;
    const parsed = parseBingResultItem(match[1] ?? "");
    if (parsed) results.push(parsed);
  }

  return { data: results, is_error: false } as const;
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
  validateInput(input) {
    if (!input || typeof input !== 'object') return 'Input must be an object.'
    if (typeof input.query !== 'string' || !input.query.trim()) return 'query is required.'
    if (input.num_results !== undefined && typeof input.num_results !== 'number') {
      return 'num_results must be a number.'
    }
  },
  async call(input, context) {
    const { query } = input

    try {
      // Clamp once so every provider (including the DuckDuckGo fallback) and
      // the enrichment loop honor the 1..10 budget.
      const numResults = clampProviderLimit(
        typeof input.num_results === 'number' ? input.num_results : 5
      )
      const userSignal = context.abortSignal
      const providerAttempts: Record<WebSearchProviderName, () => Promise<unknown>> = {
        exa: () => searchWithExa(query, numResults, context.sandbox, userSignal),
        pipellm: () => searchWithPipellm(query, numResults, context.sandbox, userSignal),
        zhipu: () => searchWithZhipu(query, numResults, context.sandbox, userSignal),
        tavily: () => searchWithTavily(query, numResults, context.sandbox, userSignal),
        brave: () => searchWithBrave(query, numResults, context.sandbox, userSignal),
        duckduckgo: () => searchWithDuckDuckGo(query, numResults, context.sandbox, userSignal),
        bing: () => searchWithBing(query, numResults, context.sandbox, userSignal),
      }
      const attempts = resolveEnabledWebSearchProviders()
        .map((provider) => providerAttempts[provider])

      let rawResults: SearchResult[] | null = null
      let lastError: unknown = null

      for (const attempt of attempts) {
        if (userSignal?.aborted) {
          lastError = new Error('request aborted')
          break
        }
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
        ? await enrichResultsWithContent(rawResults.slice(0, numResults), context.sandbox, userSignal)
        : rawResults

      return { data: enriched }
    } catch (err: any) {
      return { data: `Search error: ${err.message}`, is_error: true }
    }
  },
})

function isSearchProviderResult(value: unknown): value is { data: SearchResult[]; is_error?: boolean } {
  return !!value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)
}

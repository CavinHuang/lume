/**
 * WebSearchTool - Web search with provider fallback
 */

import { defineTool } from './types.js'
import { ensureNetworkAllowed } from '../utils/pathing.js'
import { sdkFetch } from './web-request.js'

interface SearchResult {
  title: string
  url: string
  snippet?: string
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

function getBraveApiKey(): string | undefined {
  return process.env.BRAVE_API_KEY?.trim() || process.env.LUME_BRAVE_API_KEY?.trim() || undefined
}

function getTavilyApiKey(): string | undefined {
  return process.env.TAVILY_API_KEY?.trim() || process.env.LUME_TAVILY_API_KEY?.trim() || undefined
}

function normalizeResults(results: SearchResult[], query: string, numResults: number) {
  return {
    query,
    results: results.slice(0, Math.max(1, Math.min(numResults || 5, results.length))),
  }
}

async function searchWithBrave(query: string, numResults: number, sandbox: unknown) {
  const apiKey = getBraveApiKey()
  if (!apiKey) return null
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.max(1, Math.min(numResults || 5, 10))}`
  const sandboxError = ensureNetworkAllowed(url, sandbox as never)
  if (sandboxError) {
    return { data: sandboxError, is_error: true } as const
  }
  const response = await sdkFetch(url, {
    headers: {
      'x-subscription-token': apiKey,
      accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; AgentSDK/1.0)',
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) {
    throw new Error(`Brave search failed: HTTP ${response.status}`)
  }
  const payload = await response.json() as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> }
  }
  const results = (payload.web?.results ?? [])
    .map((item) => ({
      title: item.title ?? '',
      url: item.url ?? '',
      snippet: item.description ?? '',
    }))
    .filter((item) => item.title && item.url)
  return { data: normalizeResults(results, query, numResults) } as const
}

async function searchWithTavily(query: string, numResults: number, sandbox: unknown) {
  const apiKey = getTavilyApiKey()
  if (!apiKey) return null
  const url = 'https://api.tavily.com/search'
  const sandboxError = ensureNetworkAllowed(url, sandbox as never)
  if (sandboxError) {
    return { data: sandboxError, is_error: true } as const
  }
  const response = await sdkFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; AgentSDK/1.0)',
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: Math.max(1, Math.min(numResults || 5, 10)),
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) {
    throw new Error(`Tavily search failed: HTTP ${response.status}`)
  }
  const payload = await response.json() as {
    results?: Array<{ title?: string; url?: string; content?: string }>
  }
  const results = (payload.results ?? [])
    .map((item) => ({
      title: item.title ?? '',
      url: item.url ?? '',
      snippet: item.content ?? '',
    }))
    .filter((item) => item.title && item.url)
  return { data: normalizeResults(results, query, numResults) } as const
}

async function searchWithDuckDuckGo(query: string, numResults: number, sandbox: unknown) {
  const encoded = encodeURIComponent(query)
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`
  const sandboxError = ensureNetworkAllowed(url, sandbox as never)
  if (sandboxError) {
    return { data: sandboxError, is_error: true } as const
  }
  const response = await sdkFetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AgentSDK/1.0)',
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed: HTTP ${response.status}`)
  }

  const html = await response.text()
  const resultRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippetRegex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi

  let match: RegExpExecArray | null
  const links: Array<{ title: string; url: string }> = []

  while ((match = resultRegex.exec(html)) !== null) {
    const href = decodeDuckDuckGoRedirectUrl(match[1] ?? '')
    const title = match[2].replace(/<[^>]+>/g, '').trim()
    if (href && title) {
      links.push({ title, url: href })
    }
  }

  const snippets: string[] = []
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(match[1].replace(/<[^>]+>/g, '').trim())
  }

  const results: SearchResult[] = []
  const limit = Math.min(numResults || 5, links.length)
  for (let i = 0; i < limit; i++) {
    const link = links[i]
    if (!link) continue
    results.push({
      title: link.title,
      url: link.url,
      snippet: snippets[i],
    })
  }

  return { data: normalizeResults(results, query, numResults) } as const
}

export const WebSearchTool = defineTool({
  name: 'WebSearch',
  description: 'Search the web for information. Returns search results with titles, URLs, and snippets.',
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
      const attempts = [
        () => searchWithBrave(query, numResults, context.sandbox),
        () => searchWithTavily(query, numResults, context.sandbox),
        () => searchWithDuckDuckGo(query, numResults, context.sandbox),
      ]

      let lastError: unknown = null
      for (const attempt of attempts) {
        try {
          const result = await attempt()
          if (result) {
            return result
          }
        } catch (error) {
          lastError = error
        }
      }

      throw lastError ?? new Error('No search provider available')
    } catch (err: any) {
      return { data: `Search error: ${err.message}`, is_error: true }
    }
  },
})

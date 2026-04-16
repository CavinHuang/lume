/**
 * WebSearch 工具结果渲染器
 *
 * 将搜索结果渲染为卡片列表（title + URL + snippet）
 */

import { ExternalLink, Globe } from 'lucide-react'
import { openExternal } from '@/lib/desktop-api'

interface SearchResultItem {
  title?: string
  url?: string
  snippet?: string
  description?: string
}

interface WebSearchResultProps {
  input: Record<string, unknown>
  result: unknown
}

function parseResults(result: unknown): SearchResultItem[] {
  if (!result) return []
  if (typeof result === 'string') {
    try {
      const parsed = JSON.parse(result)
      if (Array.isArray(parsed)) return parsed
      if (parsed.results && Array.isArray(parsed.results)) return parsed.results
      return [parsed]
    } catch {
      return []
    }
  }
  if (Array.isArray(result)) return result
  if (typeof result === 'object' && result !== null) {
    const obj = result as Record<string, unknown>
    if (Array.isArray(obj.results)) return obj.results as SearchResultItem[]
    return [obj as SearchResultItem]
  }
  return []
}

export function WebSearchResult({ input, result }: WebSearchResultProps) {
  const query = (input.query as string) ?? ''
  const items = parseResults(result)

  return (
    <div className="space-y-2">
      {query && (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Globe size={12} />
          <span>搜索: {query}</span>
        </div>
      )}

      {items.length === 0 ? (
        <div className="text-[12px] text-muted-foreground/60">无搜索结果</div>
      ) : (
        <div className="space-y-1.5">
          {items.map((item, i) => (
            <button
              key={i}
              onClick={() => item.url && openExternal(item.url)}
              className="w-full text-left px-3 py-2 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors group"
            >
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium text-foreground/90 truncate group-hover:text-primary transition-colors">
                    {item.title ?? item.url ?? `结果 ${i + 1}`}
                  </div>
                  {item.url && (
                    <div className="text-[10px] text-muted-foreground/60 truncate mt-0.5">
                      {item.url}
                    </div>
                  )}
                  {(item.snippet ?? item.description) && (
                    <div className="text-[11px] text-muted-foreground mt-1 line-clamp-2">
                      {item.snippet ?? item.description}
                    </div>
                  )}
                </div>
                <ExternalLink size={11} className="text-muted-foreground/40 mt-0.5 shrink-0 group-hover:text-primary/60" />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

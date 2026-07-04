import { Button } from '@/components/ui/button'
/**
 * GuanlanSearch 工具结果渲染器
 *
 * 将观澜搜索结果渲染为卡片列表（title + URL + snippet）
 */

import { ExternalLink, Globe } from 'lucide-react'
import { openExternal } from '@/lib/desktop-api'

interface SearchResultItem {
  title?: string
  url?: string
  snippet?: string
  description?: string
}

interface GuanlanSearchResultProps {
  input: Record<string, unknown>
  result: unknown
}

function parseResults(result: unknown): SearchResultItem[] {
  if (!result) return []
  if (typeof result === 'string') {
    // 优先尝试 JSON 解析（结构化数据）
    try {
      const parsed = JSON.parse(result)
      if (Array.isArray(parsed)) return parsed
      if (parsed.results && Array.isArray(parsed.results)) return parsed.results
      return [parsed]
    } catch {
      // JSON 解析失败，尝试解析 guanlan 文本格式
      return parseGuanlanTextFormat(result)
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

/**
 * 解析 guanlan 文本格式的搜索结果
 * 格式：
 *   [1] Title
 *   URL: https://...
 *   Snippet text
 *
 *   [2] Title
 *   URL: https://...
 *   Snippet text
 */
function parseGuanlanTextFormat(text: string): SearchResultItem[] {
  const items: SearchResultItem[] = []
  // 按编号分割：[1], [2], ...
  const blocks = text.split(/\n(?=\[\d+\])/)
  for (const block of blocks) {
    const lines = block.trim().split('\n')
    // 第一行：[N] Title
    const titleMatch = lines[0]?.match(/^\[\d+\]\s*(.+)/)
    const title = titleMatch?.[1]?.trim()
    if (!title) continue
    let url: string | undefined
    const snippetLines: string[] = []
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      const urlMatch = line.match(/^URL:\s*(.+)/i)
      if (urlMatch) {
        url = urlMatch[1].trim()
      } else if (line.trim()) {
        snippetLines.push(line.trim())
      }
    }
    items.push({ title, url, snippet: snippetLines.join(' ') || undefined })
  }
  return items
}

export function GuanlanSearchResult({ input, result }: GuanlanSearchResultProps) {
  const query = (input.query as string) ?? ''
  const items = parseResults(result)

  return (
    <div className="space-y-2">
      {query && (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Globe size={12} />
          <span>观澜搜索: {query}</span>
        </div>
      )}

      {items.length === 0 ? (
        <div className="text-[12px] text-muted-foreground/60">无搜索结果</div>
      ) : (
        <div className="space-y-1.5">
          {items.map((item, i) => (
            <Button
                variant="ghost"
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
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

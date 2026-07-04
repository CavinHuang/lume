import { Button } from '@/components/ui/button'
/**
 * WebFetch 工具结果渲染器
 *
 * 渲染 WebFetch 工具返回的页面内容（Markdown 格式）
 */

import { ExternalLink, Globe } from 'lucide-react'
import { CollapsibleResult } from './collapsible-result'
import { openExternal } from '@/lib/desktop-api'

interface WebFetchResultProps {
  input: Record<string, unknown>
  result: unknown
}

function extractContent(result: unknown): string {
  if (typeof result === 'string') return result
  if (typeof result === 'object' && result !== null) {
    const obj = result as Record<string, unknown>
    if (typeof obj.content === 'string') return obj.content
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.markdown === 'string') return obj.markdown
    return JSON.stringify(obj, null, 2)
  }
  return String(result ?? '')
}

export function WebFetchResult({ input, result }: WebFetchResultProps) {
  const url = (input.url as string) ?? ''
  const content = extractContent(result)

  return (
    <div className="space-y-2">
      {url && (
        <Button
                variant="ghost"
          onClick={() => openExternal(url)}
          className="flex items-center gap-2 text-[12px] text-muted-foreground hover:text-primary transition-colors group"
        >
          <Globe size={12} />
          <span className="truncate">{url}</span>
          <ExternalLink size={10} className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
        </Button>
      )}

      <CollapsibleResult
        content={content}
        threshold={2000}
        previewLines={20}
        renderContent={(text) => (
          <pre className="text-[11px] text-foreground/80 whitespace-pre-wrap break-words font-mono bg-muted/20 rounded-lg p-3 overflow-x-auto">
            {text}
          </pre>
        )}
      />
    </div>
  )
}

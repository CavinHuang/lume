import { Button } from '@/components/ui/button'
/**
 * Guanlan 文本工具共享渲染器
 *
 * 用于 guanlan_read / guanlan_hotnews / guanlan_research
 * 通过 variant 区分头部信息，内容区用 CollapsibleResult 包裹
 * read/research 使用 XMarkdown 渲染 markdown 内容
 */

import { FlaskConical, Globe, Newspaper } from 'lucide-react'
import { XMarkdown } from '@ant-design/x-markdown'
import { CollapsibleResult } from './collapsible-result'
import { openExternal } from '@/lib/desktop-api'

type GuanlanTextVariant = 'read' | 'hotnews' | 'research'

interface GuanlanTextResultProps {
  variant: GuanlanTextVariant
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

const VARIANT_CONFIG: Record<GuanlanTextVariant, { icon: typeof Globe; label: string; markdown: boolean }> = {
  read: { icon: Globe, label: '网页阅读', markdown: true },
  hotnews: { icon: Newspaper, label: '热榜', markdown: false },
  research: { icon: FlaskConical, label: '研究', markdown: true },
}

export function GuanlanTextResult({ variant, input, result }: GuanlanTextResultProps) {
  const content = extractContent(result)
  const config = VARIANT_CONFIG[variant]
  const Icon = config.icon

  const headerText =
    variant === 'read'
      ? (input.url as string) ?? ''
      : variant === 'hotnews'
        ? `来源: ${(input.source as string) ?? 'today'}`
        : (input.query as string) ?? ''

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <Icon size={12} />
        <span>{config.label}:</span>
        {variant === 'read' && headerText ? (
          <Button
                variant="ghost"
            onClick={() => openExternal(headerText)}
            className="truncate hover:text-primary transition-colors"
          >
            {headerText}
          </Button>
        ) : (
          <span className="truncate">{headerText}</span>
        )}
      </div>

      <CollapsibleResult
        content={content}
        threshold={3000}
        previewLines={15}
        renderContent={(text) =>
          config.markdown ? (
            <div className="text-[12px] leading-6 text-foreground/80 bg-muted/20 rounded-lg p-3 overflow-x-auto [&_.x-markdown]:text-[12px] [&_.x-markdown]:leading-6 [&_.x-markdown_h1]:text-[16px] [&_.x-markdown_h1]:font-bold [&_.x-markdown_h2]:text-[14px] [&_.x-markdown_h2]:font-bold [&_.x-markdown_h3]:text-[13px] [&_.x-markdown_h3]:font-semibold [&_.x-markdown_a]:text-primary [&_.x-markdown_a:hover]:underline [&_.x-markdown_pre]:bg-muted/40 [&_.x-markdown_pre]:rounded-md [&_.x-markdown_code]:text-[11px] [&_.x-markdown_table]:w-full [&_.x-markdown_th]:text-left [&_.x-markdown_th]:p-1.5 [&_.x-markdown_td]:p-1.5">
              <XMarkdown>{text}</XMarkdown>
            </div>
          ) : (
            <pre className="text-[11px] text-foreground/80 whitespace-pre-wrap break-words font-mono bg-muted/20 rounded-lg p-3 overflow-x-auto">
              {text}
            </pre>
          )
        }
      />
    </div>
  )
}

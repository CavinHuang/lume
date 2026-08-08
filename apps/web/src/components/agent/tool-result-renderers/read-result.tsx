import { HighlightedCode } from './highlighted-code'
import { inferCodeLanguageFromPath } from '../code-language'

interface Props { input: Record<string, unknown>; result: unknown }

/** read 工具结果可能是数组型多模态内容（如 readImage 返回 [text, image]），提取文本块避免被 String() 成 [object Object]（见 #14） */
function extractResultText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    return raw
      .map((block) => (block && typeof block === 'object' && 'text' in block
        ? String((block as { text: unknown }).text)
        : ''))
      .filter(Boolean)
      .join('\n')
  }
  return String(raw ?? '')
}

export function ReadResult({ input, result }: Props) {
  const rawContent = (result as Record<string, unknown>)?.content ?? result
  const content = extractResultText(rawContent)
  const filePath = String(input.file_path ?? '')
  const language = inferCodeLanguageFromPath(filePath)

  return (
    <div className="rounded-lg overflow-hidden">
      <div className="px-3 py-1.5 text-[11px] text-foreground/50 bg-muted/40 font-mono truncate">
        {filePath}
      </div>
      <HighlightedCode code={content} language={language} showLineNumbers maxLines={30} />
    </div>
  )
}

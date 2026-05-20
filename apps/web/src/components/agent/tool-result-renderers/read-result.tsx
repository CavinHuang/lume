import { HighlightedCode } from './highlighted-code'
import { inferCodeLanguageFromPath } from '../code-language'

interface Props { input: Record<string, unknown>; result: unknown }

export function ReadResult({ input, result }: Props) {
  const content = (result as Record<string, unknown>)?.content ?? String(result ?? '')
  const filePath = String(input.file_path ?? '')
  const language = inferCodeLanguageFromPath(filePath)

  return (
    <div className="rounded-lg overflow-hidden">
      <div className="px-3 py-1.5 text-[11px] text-foreground/50 bg-muted/40 font-mono truncate">
        {filePath}
      </div>
      <HighlightedCode code={String(content)} language={language} showLineNumbers maxLines={30} />
    </div>
  )
}

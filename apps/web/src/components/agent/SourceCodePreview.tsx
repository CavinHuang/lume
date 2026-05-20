import { HighlightedCode } from './tool-result-renderers/highlighted-code'
import { inferCodeLanguageFromPath } from './code-language'

interface SourceCodePreviewProps {
  content: string
  path: string
}

export function SourceCodePreview({ content, path }: SourceCodePreviewProps) {
  return (
    <HighlightedCode
      code={content}
      language={inferCodeLanguageFromPath(path)}
      showLineNumbers
      className="border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)]"
    />
  )
}

import type { ReactNode } from 'react'
import { BashResult } from './bash-result'
import { ReadResult } from './read-result'
import { EditResult } from './edit-result'
import { WriteResult } from './write-result'
import { GrepResult } from './grep-result'
import { GlobResult } from './glob-result'
import { WebSearchResult } from './web-search-result'
import { WebFetchResult } from './web-fetch-result'
import { DefaultResult } from './default-result'

interface ToolResultRendererProps {
  toolName: string
  input: Record<string, unknown>
  result: unknown
}

export function ToolResultRenderer({ toolName, input, result }: ToolResultRendererProps): ReactNode {
  switch (toolName) {
    case 'Bash': return <BashResult input={input} result={result} />
    case 'Read': return <ReadResult input={input} result={result} />
    case 'Edit': return <EditResult input={input} result={result} />
    case 'Write': return <WriteResult input={input} result={result} />
    case 'Grep': return <GrepResult input={input} result={result} />
    case 'Glob': return <GlobResult input={input} result={result} />
    case 'WebSearch': return <WebSearchResult input={input} result={result} />
    case 'WebFetch': return <WebFetchResult input={input} result={result} />
    default: return <DefaultResult toolName={toolName} input={input} result={result} />
  }
}

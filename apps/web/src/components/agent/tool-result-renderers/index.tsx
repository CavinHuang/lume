import type { ReactNode } from 'react'
import { BashResult } from './bash-result'
import { ReadResult } from './read-result'
import { EditResult } from './edit-result'
import { WriteResult } from './write-result'
import { GrepResult } from './grep-result'
import { GlobResult } from './glob-result'
import { WebSearchResult } from './web-search-result'
import { WebFetchResult } from './web-fetch-result'
import { GuanlanSearchResult } from './guanlan-search-result'
import { GuanlanTextResult } from './guanlan-text-result'
import { InfoExtractResult } from './info-extract-result'
import { ImageGenResult } from './image-gen-result'
import { TodoResult } from './todo-result'
import { DefaultResult } from './default-result'
import { WikiProposalResult } from './wiki-proposal-result'
import { PlanningTodoResult } from './planning-todo-result'

interface ToolResultRendererProps {
  toolName: string
  input: Record<string, unknown>
  result: unknown
  imagePresentation?: 'default' | 'gallery'
}

export function ToolResultRenderer({ toolName, input, result, imagePresentation }: ToolResultRendererProps): ReactNode {
  switch (toolName) {
    case 'Bash': return <BashResult input={input} result={result} />
    case 'Read': return <ReadResult input={input} result={result} />
    case 'Edit': return <EditResult input={input} result={result} />
    case 'Write': return <WriteResult input={input} result={result} />
    case 'Grep': return <GrepResult input={input} result={result} />
    case 'Glob': return <GlobResult input={input} result={result} />
    case 'WebSearch': return <WebSearchResult input={input} result={result} />
    case 'WebFetch': return <WebFetchResult input={input} result={result} />
    case 'guanlan_search': return <GuanlanSearchResult input={input} result={result} />
    case 'guanlan_read': return <GuanlanTextResult variant="read" input={input} result={result} />
    case 'guanlan_hotnews': return <GuanlanTextResult variant="hotnews" input={input} result={result} />
    case 'guanlan_research': return <GuanlanTextResult variant="research" input={input} result={result} />
    // fail-fast（ok:false）时专用渲染器会展示空计划卡片，回落默认渲染器显示错误
    case 'info_extract':
      return result && typeof result === 'object' && (result as { ok?: unknown }).ok === false
        ? <DefaultResult toolName={toolName} input={input} result={result} />
        : <InfoExtractResult input={input} result={result} />
    case 'image_gen': return <ImageGenResult input={input} result={result} presentation={imagePresentation} />
    case 'TodoWrite': return <TodoResult input={input} result={result} />
    case 'wiki.propose_changes': return <WikiProposalResult result={result} />
    case 'memory.remember':
    case 'memory.forget':
      return null
    case 'PlanningTodoList':
    case 'PlanningTodoGet':
    case 'PlanningTodoCreate':
    case 'PlanningTodoUpdate':
    case 'PlanningTodoComplete':
    case 'PlanningTodoReopen':
    case 'PlanningTodoDelete':
    case 'PlanningTodoRestore':
      return <PlanningTodoResult toolName={toolName} input={input} result={result} />
    default: return <DefaultResult toolName={toolName} input={input} result={result} />
  }
}

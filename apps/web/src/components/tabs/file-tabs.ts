import type { FileTabSource, Tab } from '@/atoms'

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).at(-1) ?? path
}

export function buildFileTab(input: {
  filePath: string
  fileSource: FileTabSource
  workspaceSlug?: string
  threadId?: string
  sourcePath?: string
}): Tab {
  const scopeKey = input.fileSource === 'local'
    ? input.sourcePath ?? input.filePath
    : `${input.workspaceSlug ?? ''}:${input.threadId ?? ''}:${input.filePath}`

  return {
    id: `file:${input.fileSource}:${scopeKey}`,
    type: 'file',
    title: basename(input.filePath),
    filePath: input.filePath,
    fileSource: input.fileSource,
    ...(input.workspaceSlug ? { workspaceSlug: input.workspaceSlug } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
  }
}

export function buildThreadPlanFileTab(input: {
  threadId: string
  planFilePath: string
  workspaceSlug?: string
}): Tab {
  return buildFileTab({
    filePath: input.planFilePath,
    fileSource: 'thread',
    threadId: input.threadId,
    ...(input.workspaceSlug ? { workspaceSlug: input.workspaceSlug } : {}),
  })
}

export function upsertTab(tabs: Tab[], nextTab: Tab): Tab[] {
  const existingIndex = tabs.findIndex((tab) => tab.id === nextTab.id)
  if (existingIndex === -1) {
    return [...tabs, nextTab]
  }
  return tabs.map((tab, index) => (index === existingIndex ? nextTab : tab))
}

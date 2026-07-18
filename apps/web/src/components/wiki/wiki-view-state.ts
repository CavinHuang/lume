import type { WikiPageRef, WikiSearchScope } from '@lume/shared'

export type WikiFolderFilter =
  | { kind: 'all' }
  | { kind: 'inbox' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'archived' }

export function filterWikiPages(
  pages: WikiPageRef[],
  resultIds: string[] | null,
  folder: WikiFolderFilter = { kind: 'all' },
): WikiPageRef[] {
  const wanted = resultIds ? new Set(resultIds) : null
  return pages.filter((page) => {
    if (wanted && !wanted.has(page.id)) return false
    if (folder.kind === 'archived') return page.status === 'archived'
    if (page.status !== 'active') return false
    if (folder.kind === 'inbox') return page.primaryWorkspaceId === null
    if (folder.kind === 'workspace') return page.primaryWorkspaceId === folder.workspaceId
    return true
  })
}

export function countWikiPages(pages: WikiPageRef[], folder: WikiFolderFilter): number {
  return filterWikiPages(pages, null, folder).length
}

export function defaultAskWikiScope(selectedPageId: string | null, workspaceId: string | null): WikiSearchScope {
  if (selectedPageId) return { kind: 'page', pageId: selectedPageId }
  if (workspaceId) return { kind: 'workspace', workspaceId }
  return { kind: 'inbox' }
}

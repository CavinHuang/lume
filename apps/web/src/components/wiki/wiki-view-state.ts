import type { WikiPageRef, WikiSearchScope } from '@lume/shared'

export function filterWikiPages(pages: WikiPageRef[], resultIds: string[] | null): WikiPageRef[] {
  if (!resultIds) return pages.filter((page) => page.status !== 'trashed')
  const wanted = new Set(resultIds)
  return pages.filter((page) => wanted.has(page.id))
}

export function defaultAskWikiScope(selectedPageId: string | null, workspaceId: string | null): WikiSearchScope {
  if (selectedPageId) return { kind: 'page', pageId: selectedPageId }
  if (workspaceId) return { kind: 'workspace', workspaceId }
  return { kind: 'inbox' }
}

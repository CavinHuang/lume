import { describe, expect, test } from 'bun:test'
import type { WikiPageRef } from '@lume/shared'
import { countWikiPages, defaultAskWikiScope, filterWikiPages } from './wiki-view-state'

const pages: WikiPageRef[] = [
  { id: 'a', fileKey: 'a', title: 'A', type: 'topic', status: 'active', primaryWorkspaceId: null, associatedWorkspaceIds: [] },
  { id: 'b', fileKey: 'b', title: 'B', type: 'topic', status: 'trashed', primaryWorkspaceId: null, associatedWorkspaceIds: [] },
  { id: 'c', fileKey: 'c', title: 'C', type: 'decision', status: 'active', primaryWorkspaceId: 'workspace-1', associatedWorkspaceIds: [] },
  { id: 'd', fileKey: 'd', title: 'D', type: 'topic', status: 'archived', primaryWorkspaceId: 'workspace-1', associatedWorkspaceIds: [] },
]

describe('wiki view state', () => {
  test('combines folder placement with search results', () => {
    expect(filterWikiPages(pages, null).map((page) => page.id)).toEqual(['a', 'c'])
    expect(filterWikiPages(pages, null, { kind: 'inbox' }).map((page) => page.id)).toEqual(['a'])
    expect(filterWikiPages(pages, ['a', 'c'], { kind: 'workspace', workspaceId: 'workspace-1' }).map((page) => page.id)).toEqual(['c'])
    expect(filterWikiPages(pages, null, { kind: 'archived' }).map((page) => page.id)).toEqual(['d'])
    expect(countWikiPages(pages, { kind: 'workspace', workspaceId: 'workspace-1' })).toBe(1)
  })
  test('prefers page, then workspace, then inbox scope', () => {
    expect(defaultAskWikiScope('page-1', 'workspace-1')).toEqual({ kind: 'page', pageId: 'page-1' })
    expect(defaultAskWikiScope(null, 'workspace-1')).toEqual({ kind: 'workspace', workspaceId: 'workspace-1' })
    expect(defaultAskWikiScope(null, null)).toEqual({ kind: 'inbox' })
  })
})

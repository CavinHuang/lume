import { describe, expect, test } from 'bun:test'
import type { WikiPageRef } from '@lume/shared'
import { defaultAskWikiScope, filterWikiPages } from './wiki-view-state'

const pages: WikiPageRef[] = [
  { id: 'a', fileKey: 'a', title: 'A', type: 'topic', status: 'active', primaryWorkspaceId: null, associatedWorkspaceIds: [] },
  { id: 'b', fileKey: 'b', title: 'B', type: 'topic', status: 'trashed', primaryWorkspaceId: null, associatedWorkspaceIds: [] },
]

describe('wiki view state', () => {
  test('hides trash normally but honors explicit search ids', () => {
    expect(filterWikiPages(pages, null).map((page) => page.id)).toEqual(['a'])
    expect(filterWikiPages(pages, ['b']).map((page) => page.id)).toEqual(['b'])
  })
  test('prefers page, then workspace, then inbox scope', () => {
    expect(defaultAskWikiScope('page-1', 'workspace-1')).toEqual({ kind: 'page', pageId: 'page-1' })
    expect(defaultAskWikiScope(null, 'workspace-1')).toEqual({ kind: 'workspace', workspaceId: 'workspace-1' })
    expect(defaultAskWikiScope(null, null)).toEqual({ kind: 'inbox' })
  })
})

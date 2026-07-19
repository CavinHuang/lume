import { describe, expect, test } from 'bun:test'
import { WIKI_IPC_CHANNELS, WIKI_SCHEMA_VERSION, type WikiPageFrontmatter } from './wiki'

describe('wiki shared contract', () => {
  test('uses nullable primary workspace for inbox and immutable file key identity', () => {
    const page: WikiPageFrontmatter = {
      schema_version: WIKI_SCHEMA_VERSION,
      id: 'page-1', file_key: 'wiki-file-key', type: 'topic', title: 'Inbox',
      primary_workspace_id: null, primary_workspace_snapshot: null,
      associated_workspace_ids: [], status: 'active', aliases: [], tags: [], source_ids: [],
      created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', revision: 1,
    }
    expect(page.primary_workspace_id).toBeNull()
    expect(page.file_key).toBe('wiki-file-key')
  })

  test('keeps renderer mutation surface draft-id based', () => {
    expect(WIKI_IPC_CHANNELS.APPLY_DRAFT).toBe('wiki:apply-draft')
    expect(WIKI_IPC_CHANNELS.GET_DRAFT_STATUS).toBe('wiki:get-draft-status')
    expect(WIKI_IPC_CHANNELS.PREPARE_RUNTIME).toBe('wiki:prepare-runtime')
    expect(Object.values(WIKI_IPC_CHANNELS)).not.toContain('wiki:apply-paths')
  })
})

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_MEMORY_CENTER_LINK,
  isMemoryCenterLinkForWorkspace,
  normalizeMemoryCenterLink,
} from './memory-center-state'

describe('memory center navigation state', () => {
  test('falls back to the attention section', () => {
    expect(normalizeMemoryCenterLink()).toEqual(DEFAULT_MEMORY_CENTER_LINK)
    expect(normalizeMemoryCenterLink({ section: 'unknown' as never })).toEqual(DEFAULT_MEMORY_CENTER_LINK)
  })

  test('preserves valid sections and targets for the current workspace', () => {
    expect(normalizeMemoryCenterLink({
      section: 'memory',
      workspaceSlug: 'demo',
      libraryView: 'workspace',
      memoryId: 'mem-1',
      mutationId: 'mutation-1',
      jobId: 'job-1',
    }, 'demo')).toEqual({
      section: 'memory',
      workspaceSlug: 'demo',
      libraryView: 'workspace',
      memoryId: 'mem-1',
      mutationId: 'mutation-1',
      jobId: 'job-1',
    })
  })

  test('clears workspace-bound targets after switching workspace', () => {
    expect(normalizeMemoryCenterLink({
      section: 'activity',
      workspaceSlug: 'old',
      memoryId: 'mem-1',
      mutationId: 'mutation-1',
      jobId: 'job-1',
    }, 'next')).toEqual({
      section: 'activity',
      workspaceSlug: 'next',
      mutationId: 'mutation-1',
    })
  })

  test('recognizes links for the selected workspace', () => {
    expect(isMemoryCenterLinkForWorkspace({ section: 'attention', workspaceSlug: 'demo' }, 'demo')).toBe(true)
    expect(isMemoryCenterLinkForWorkspace({ section: 'attention', workspaceSlug: 'other' }, 'demo')).toBe(false)
    expect(isMemoryCenterLinkForWorkspace({ section: 'attention' }, 'demo')).toBe(true)
  })
})

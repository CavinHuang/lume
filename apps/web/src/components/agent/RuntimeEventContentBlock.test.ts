import { describe, expect, test } from 'bun:test'
import {
  formatMessageAttachmentSize,
  getTaskProgressStatusText,
  getToolPermissionTitleBadgeText,
  compactMemoryCitationLabel,
  groupMemoryCitationItems,
  normalizeMemoryCitationPath,
  showTemporaryCopiedFeedback,
  type CopyFeedbackState,
} from './RuntimeEventContentBlock'
import { normalizeThreadFilePathCandidate } from './thread-file-links'
import type { LumeRuntimeEvent } from '@lume/shared'

describe('showTemporaryCopiedFeedback', () => {
  test('sets copied immediately, clears the previous timer, and resets after 3 seconds', () => {
    const copiedStates: boolean[] = []
    const clearedTimerIds: number[] = []
    const scheduled: Array<{ id: number; delayMs: number; callback: () => void }> = []
    let nextTimerId = 1
    const state: CopyFeedbackState = { resetTimeoutId: null }

    const setTimer = (callback: () => void, delayMs: number) => {
      const id = nextTimerId
      nextTimerId += 1
      scheduled.push({ id, delayMs, callback })
      return id as ReturnType<typeof setTimeout>
    }

    const clearTimer = (handle: ReturnType<typeof setTimeout>) => {
      clearedTimerIds.push(handle as number)
    }

    showTemporaryCopiedFeedback(state, {
      setCopied: (next) => copiedStates.push(next),
      setTimer,
      clearTimer,
    })

    expect(copiedStates).toEqual([true])
    expect(state.resetTimeoutId).toBe(1)
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.delayMs).toBe(3000)

    showTemporaryCopiedFeedback(state, {
      setCopied: (next) => copiedStates.push(next),
      setTimer,
      clearTimer,
    })

    expect(clearedTimerIds).toEqual([1])
    expect(copiedStates).toEqual([true, true])
    expect(state.resetTimeoutId).toBe(2)
    expect(scheduled).toHaveLength(2)

    scheduled[1]?.callback()

    expect(copiedStates).toEqual([true, true, false])
    expect(state.resetTimeoutId).toBeNull()
  })
})

describe('normalizeThreadFilePathCandidate', () => {
  test('accepts relative thread file paths and rejects external or unsafe paths', () => {
    expect(normalizeThreadFilePathCandidate('plans/deepseek-open-source-research.md')).toBe('plans/deepseek-open-source-research.md')
    expect(normalizeThreadFilePathCandidate('files/My Report.md')).toBe('files/My Report.md')
    expect(normalizeThreadFilePathCandidate('files\\notes\\brief.md')).toBe('files/notes/brief.md')
    expect(normalizeThreadFilePathCandidate('https://example.com/report.md')).toBeNull()
    expect(normalizeThreadFilePathCandidate('/Users/me/report.md')).toBeNull()
    expect(normalizeThreadFilePathCandidate('../report.md')).toBeNull()
    expect(normalizeThreadFilePathCandidate('report.md')).toBeNull()
  })
})

describe('normalizeMemoryCitationPath', () => {
  test('extracts absolute paths from memory citation schemes', () => {
    expect(normalizeMemoryCitationPath('workspace:daily:/Users/me/.lume/agent-workspaces/default/memory/daily/2026-05-19.md'))
      .toBe('/Users/me/.lume/agent-workspaces/default/memory/daily/2026-05-19.md')
    expect(normalizeMemoryCitationPath('workspace:memory:/Users/me/.lume/agent-workspaces/default/MEMORY.md#L3-L4'))
      .toBe('/Users/me/.lume/agent-workspaces/default/MEMORY.md')
  })

  test('rejects non-file citations', () => {
    expect(normalizeMemoryCitationPath('memory-entry-id')).toBeNull()
    expect(normalizeMemoryCitationPath('workspace:daily:relative/path.md')).toBeNull()
  })
})

describe('memory citation grouping', () => {
  test('groups memory citations by injected memory role and hides empty groups', () => {
    const groups = groupMemoryCitationItems([
      {
        id: 'claim-1',
        kind: 'preference',
        scope: 'global',
        status: 'active',
        citation: 'global:memory:/Users/me/.lume/memory/entries/name.md',
        reason: 'matched memory entry',
        claim: {
          subject: 'user/self',
          predicate: 'preferred_name',
          object: 'Mason',
        },
      },
      {
        id: 'global-pref-1',
        kind: 'preference',
        scope: 'global',
        status: 'active',
        citation: 'global:memory:/Users/me/.lume/memory/MEMORY.md',
        reason: 'matched memory entry',
      },
      {
        id: 'workspace-1',
        kind: 'state',
        scope: 'workspace',
        status: 'active',
        citation: 'workspace:daily:/Users/me/.lume/agent-workspaces/default/memory/daily/2026-05-20.md',
        reason: 'recent daily memory',
      },
      {
        id: 'workspace-core-1',
        kind: 'state',
        scope: 'workspace',
        status: 'active',
        citation: 'workspace:memory:/Users/me/.lume/agent-workspaces/default/memory/MEMORY.md',
        reason: 'workspace memory brief',
      },
      {
        id: 'stale-1',
        kind: 'state',
        scope: 'workspace',
        status: 'suspected_stale',
        citation: 'workspace:memory:/Users/me/.lume/agent-workspaces/default/memory/entries/old.md',
        reason: 'matched memory entry',
      },
    ] as any)

    expect(groups.map((group) => group.key)).toEqual([
      'claims',
      'workspace_core',
      'global_preferences',
      'conversation_history',
      'maybe_stale',
    ])
    expect(groups.map((group) => group.items[0]?.id)).toEqual([
      'claim-1',
      'workspace-core-1',
      'global-pref-1',
      'workspace-1',
      'stale-1',
    ])
  })

  test('compacts memory citation labels to file names', () => {
    expect(compactMemoryCitationLabel('workspace:daily:/Users/me/.lume/agent-workspaces/default/memory/daily/2026-05-20.md'))
      .toBe('2026-05-20.md')
    expect(compactMemoryCitationLabel('/Users/me/.lume/agent-workspaces/default/MEMORY.md#L3-L4'))
      .toBe('MEMORY.md')
  })
})

describe('getTaskProgressStatusText', () => {
  test('returns a compact running status from the latest task progress event', () => {
    const progress = {
      type: 'task.progress',
      currentTaskId: 'step-2',
      tasks: [
        { id: 'step-1', title: 'Patch files', status: 'completed' },
        { id: 'step-2', title: 'Run focused tests', status: 'running' },
      ],
    } as Extract<LumeRuntimeEvent, { type: 'task.progress' }>

    expect(getTaskProgressStatusText(progress)).toBe('正在执行：Run focused tests')
  })
})

describe('formatMessageAttachmentSize', () => {
  test('formats compact attachment sizes', () => {
    expect(formatMessageAttachmentSize(512)).toBe('512 B')
    expect(formatMessageAttachmentSize(2048)).toBe('2 KB')
    expect(formatMessageAttachmentSize(2 * 1024 * 1024)).toBe('2 MB')
  })
})

describe('getToolPermissionTitleBadgeText', () => {
  test('returns a compact timeout badge for timed out permission tool calls', () => {
    expect(getToolPermissionTitleBadgeText({
      id: 'tool-1',
      toolName: 'Bash',
      input: {},
      status: 'failed',
      isError: true,
      permissionState: 'timeout',
    })).toBe('权限超时')
  })
})

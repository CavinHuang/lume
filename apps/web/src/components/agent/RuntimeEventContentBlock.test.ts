import { describe, expect, test } from 'bun:test'
import {
  formatCompletedDuration,
  formatMessageAttachmentSize,
  formatRunningDuration,
  getAssistantCopyText,
  getAssistantDownloadPayload,
  getCopyTextWithoutAfterglow,
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

describe('getCopyTextWithoutAfterglow', () => {
  test('removes afterglow nodes from copied text', () => {
    const clone = {
      textContent: '正文⟡ 不要复制结尾',
      querySelectorAll: (selector: string) => selector === '[data-afterglow]' ? [{
        remove: () => {
          clone.textContent = '正文结尾'
        },
      }] : [],
    }
    const root = {
      cloneNode: () => clone,
    } as unknown as Node & ParentNode

    expect(getCopyTextWithoutAfterglow(root)).toBe('正文结尾')
  })

  test('replaces compact file chips with their complete portable copy text', () => {
    let copiedText = '查看 …/src/app.tsL3–8'
    const referenceNode = {
      dataset: { fileReferenceCopyText: 'packages/web/src/app.ts#L3-L8' },
      get textContent() { return copiedText },
      set textContent(value: string) { copiedText = `查看 ${value}` },
    }
    const clone = {
      get textContent() { return copiedText },
      querySelectorAll: (selector: string) => selector === '[data-file-reference-copy-text]' ? [referenceNode] : [],
    }
    const root = { cloneNode: () => clone } as unknown as Node & ParentNode

    expect(getCopyTextWithoutAfterglow(root)).toBe('查看 packages/web/src/app.ts#L3-L8')
  })
})

describe('getAssistantCopyText', () => {
  test('removes afterglow lines from footer copy text', () => {
    expect(getAssistantCopyText('正文\n⟡ 不要复制\n结尾')).toBe('正文\n结尾')
  })

  test('removes internal file reference prefixes while preserving line ranges', () => {
    expect(getAssistantCopyText('查看 `@project/src/app.ts#L3-L8`。')).toBe('查看 `src/app.ts#L3-L8`。')
    expect(getAssistantCopyText('[配置](@session/output/config%20file.json)')).toBe('[配置](output/config%20file.json)')
  })
})

describe('getAssistantDownloadPayload', () => {
  test('removes afterglow lines from txt downloads', () => {
    expect(getAssistantDownloadPayload('正文\n⟡ 不要导出\n结尾', 'txt')).toBe('正文\n结尾')
  })

  test('removes afterglow lines from html downloads', () => {
    const payload = getAssistantDownloadPayload('正文\n⟡ 不要导出\n结尾', 'html')

    expect(payload).toContain('<pre>正文\n结尾</pre>')
    expect(payload).not.toContain('不要导出')
    expect(payload).not.toContain('⟡')
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

describe('formatRunningDuration', () => {
  test('<60s 取整秒（运行态，round-half-up）', () => {
    expect(formatRunningDuration(500)).toBe('1s') // 0.5s → 1s
    expect(formatRunningDuration(1200)).toBe('1s') // 1.2s → 1s
    expect(formatRunningDuration(1500)).toBe('2s') // 1.5s → 2s
    expect(formatRunningDuration(59999)).toBe('60s') // 59.999s → 60s（进位）
  })
  test('>=60s 用 mm:ss', () => {
    expect(formatRunningDuration(65000)).toBe('1:05')
  })
  test('>=1h 用 h:mm:ss', () => {
    expect(formatRunningDuration(3723000)).toBe('1:02:03')
  })
  test('<=0 返回空串', () => {
    expect(formatRunningDuration(0)).toBe('')
    expect(formatRunningDuration(-5)).toBe('')
  })
})

describe('formatCompletedDuration', () => {
  test('<60s 保留 1 位小数（完成态）', () => {
    expect(formatCompletedDuration(1500)).toBe('1.5s')
    expect(formatCompletedDuration(2300)).toBe('2.3s')
  })
  test('>=60s 用 mm:ss', () => {
    expect(formatCompletedDuration(65000)).toBe('1:05')
  })
  test('>=1h 用 h:mm:ss', () => {
    expect(formatCompletedDuration(3723000)).toBe('1:02:03')
  })
  test('<=0 返回空串', () => {
    expect(formatCompletedDuration(0)).toBe('')
    expect(formatCompletedDuration(-5)).toBe('')
  })
})

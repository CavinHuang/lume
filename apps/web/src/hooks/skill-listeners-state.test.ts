import { describe, expect, test } from 'bun:test'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { buildSkillImprovementSuggestionToast } from './skill-listeners-state'

describe('skill listeners state', () => {
  test('builds a toast for skill improvement suggestion events', () => {
    expect(buildSkillImprovementSuggestionToast(AGENT_IPC_CHANNELS.SKILL_IMPROVEMENT_SUGGESTED, {
      threadId: 'thread-1',
      workspaceSlug: 'main',
      suggestions: [
        {
          workspaceSlug: 'main',
          skillSlug: 'code-review',
          usageCount: 4,
          analyzedSessionIds: ['s1', 's2'],
          updates: [
            { section: 'Workflow', change: 'Add checklist', reason: 'Repeated misses' },
            { section: 'Output', change: 'Tighten summary', reason: 'Noisy replies' },
          ],
        },
        {
          workspaceSlug: 'main',
          skillSlug: 'docs',
          usageCount: 2,
          analyzedSessionIds: ['s3'],
          updates: [
            { section: 'Style', change: 'Use shorter headings', reason: 'Reader feedback' },
          ],
        },
      ],
    })).toEqual({
      message: '发现 2 个技能可进化：code-review、docs，共 3 条建议',
    })
  })

  test('ignores unrelated or empty events', () => {
    expect(buildSkillImprovementSuggestionToast('agent:title-updated', {})).toBeNull()
    expect(buildSkillImprovementSuggestionToast(AGENT_IPC_CHANNELS.SKILL_IMPROVEMENT_SUGGESTED, {
      threadId: 'thread-1',
      workspaceSlug: 'main',
      suggestions: [],
    })).toBeNull()
  })
})

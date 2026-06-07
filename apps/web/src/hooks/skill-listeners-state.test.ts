import { describe, expect, test } from 'bun:test'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import {
  buildSkillImprovementSuggestionToast,
  extractSkillImprovementSuggestions,
  mergeSkillImprovementSuggestions,
} from './skill-listeners-state'

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

  test('keeps user-global and workspace suggestions distinct when skill slugs match', () => {
    expect(buildSkillImprovementSuggestionToast(AGENT_IPC_CHANNELS.SKILL_IMPROVEMENT_SUGGESTED, {
      threadId: 'thread-1',
      workspaceSlug: 'main',
      suggestions: [
        {
          workspaceSlug: 'main',
          storageScope: 'user',
          skillSlug: 'planner',
          usageCount: 1,
          analyzedSessionIds: ['thread-1'],
          updates: [
            { section: 'Rules', change: 'Improve global planner', reason: 'Global feedback' },
          ],
        },
        {
          workspaceSlug: 'main',
          storageScope: 'workspace',
          skillSlug: 'planner',
          usageCount: 1,
          analyzedSessionIds: ['thread-1'],
          updates: [
            { section: 'Rules', change: 'Improve workspace planner', reason: 'Project feedback' },
          ],
        },
      ],
    })).toEqual({
      message: '发现 2 个技能可进化：planner（用户全局）、planner（工作区级），共 2 条建议',
    })
  })

  test('extracts and merges pending skill improvement suggestions by storage scope', () => {
    const event = {
      threadId: 'thread-1',
      workspaceSlug: 'main',
      suggestions: [
        {
          workspaceSlug: 'main',
          storageScope: 'user',
          skillSlug: 'planner',
          usageCount: 1,
          analyzedSessionIds: ['thread-1'],
          updates: [
            { section: 'Rules', change: 'Improve global planner', reason: 'Global feedback' },
          ],
        },
        {
          workspaceSlug: 'main',
          storageScope: 'workspace',
          skillSlug: 'planner',
          usageCount: 1,
          analyzedSessionIds: ['thread-1'],
          updates: [
            { section: 'Rules', change: 'Improve workspace planner', reason: 'Project feedback' },
          ],
        },
      ],
    }

    const extracted = extractSkillImprovementSuggestions(
      AGENT_IPC_CHANNELS.SKILL_IMPROVEMENT_SUGGESTED,
      event,
    )

    expect(extracted.map((suggestion) => suggestion.key)).toEqual([
      'main:user:planner',
      'main:workspace:planner',
    ])
    expect(mergeSkillImprovementSuggestions([], extracted)).toEqual(extracted)
    expect(mergeSkillImprovementSuggestions(extracted, [{
      ...extracted[0]!,
      usageCount: 2,
      updates: [
        { section: 'Rules', change: 'Refresh global suggestion', reason: 'Newer evidence' },
      ],
    }])).toEqual([
      {
        ...extracted[0]!,
        usageCount: 2,
        updates: [
          { section: 'Rules', change: 'Refresh global suggestion', reason: 'Newer evidence' },
        ],
      },
      extracted[1],
    ])
  })

  test('keeps project suggestions from different cwd values distinct when skill slugs match', () => {
    const event = {
      threadId: 'thread-1',
      workspaceSlug: 'main',
      suggestions: [
        {
          workspaceSlug: 'main',
          storageScope: 'project',
          cwd: '/tmp/project-a',
          skillSlug: 'planner',
          usageCount: 1,
          analyzedSessionIds: ['thread-1'],
          updates: [
            { section: 'Rules', change: 'Improve project A planner', reason: 'A feedback' },
          ],
        },
        {
          workspaceSlug: 'main',
          storageScope: 'project',
          cwd: '/tmp/project-b',
          skillSlug: 'planner',
          usageCount: 1,
          analyzedSessionIds: ['thread-2'],
          updates: [
            { section: 'Rules', change: 'Improve project B planner', reason: 'B feedback' },
          ],
        },
      ],
    }

    const extracted = extractSkillImprovementSuggestions(
      AGENT_IPC_CHANNELS.SKILL_IMPROVEMENT_SUGGESTED,
      event,
    )

    expect(extracted.map((suggestion) => suggestion.key)).toEqual([
      'main:project:/tmp/project-a:planner',
      'main:project:/tmp/project-b:planner',
    ])
    expect(mergeSkillImprovementSuggestions([], extracted)).toEqual(extracted)
  })
})

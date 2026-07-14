import { describe, expect, test } from 'bun:test'
import {
  buildExpressionActionSendInput,
  deriveExpressionActions,
  getExpressionActionMessageIndex,
} from './expression-actions'

const pad = (text: string, length = 220) => text.padEnd(length, '补')

describe('deriveExpressionActions', () => {
  test('hides actions for empty, short, or streaming answers', () => {
    expect(deriveExpressionActions('')).toEqual([])
    expect(deriveExpressionActions('短回答'.padEnd(199, '短'))).toEqual([])
    expect(deriveExpressionActions(pad('这是一个流程说明'), true)).toEqual([])
  })

  test('offers a diagram for structural explanations without Mermaid', () => {
    const actions = deriveExpressionActions(pad('这个系统架构包含入口、服务和存储之间的依赖关系。'))

    expect(actions[0]).toEqual({
      id: 'diagram',
      label: '画成图',
      prompt: '请把上一条回答改写为一张清晰的 Mermaid 图，并保留不超过三句必要结论，不要重复完整原文。',
    })
  })

  test('does not offer another diagram when the answer already contains Mermaid', () => {
    const actions = deriveExpressionActions(pad('```mermaid\nflowchart LR\n  A --> B\n```\n这是流程说明。'))

    expect(actions.map((action) => action.id)).not.toContain('diagram')
  })

  test('offers condense for long answers or at least five sections', () => {
    expect(deriveExpressionActions('长'.repeat(601)).map((action) => action.id)).toContain('condense')
    expect(deriveExpressionActions(pad('# 一\n内容\n\n## 二\n内容\n\n## 三\n内容\n\n## 四\n内容\n\n## 五\n内容'))
      .map((action) => action.id)).toContain('condense')
  })

  test('offers checklist for actionable content unless a checklist already exists', () => {
    expect(deriveExpressionActions(pad('下一步需要实施这个计划，并明确执行顺序。')).map((action) => action.id))
      .toContain('checklist')
    expect(deriveExpressionActions(pad('实施计划：\n- [ ] 第一步\n- [ ] 第二步')).map((action) => action.id))
      .not.toContain('checklist')
  })

  test('returns at most two actions in diagram, condense, checklist priority order', () => {
    const actions = deriveExpressionActions(
      '系统架构和依赖关系需要按下一步计划实施。'.padEnd(650, '详'),
    )

    expect(actions.map((action) => action.id)).toEqual(['diagram', 'condense'])
  })

  test('builds a visible user turn with local trace metadata', () => {
    const action = deriveExpressionActions(pad('这个流程包含三个阶段。'))[0]!

    expect(buildExpressionActionSendInput('thread-1', 'assistant-1', action)).toEqual({
      threadId: 'thread-1',
      userMessage: action.prompt,
      messageMetadata: {
        expressionActionId: 'diagram',
        expressionActionSourceMessageId: 'assistant-1',
      },
    })
  })

  test('shows actions only when the final message is a completed assistant answer', () => {
    const completedAssistant = { type: 'assistant', status: 'completed' }
    const user = { type: 'user', status: 'completed' }

    expect(getExpressionActionMessageIndex([user, completedAssistant], false)).toBe(1)
    expect(getExpressionActionMessageIndex([completedAssistant, user], false)).toBe(-1)
    expect(getExpressionActionMessageIndex([user, completedAssistant], true)).toBe(-1)
    expect(getExpressionActionMessageIndex([user, { type: 'assistant', status: 'streaming' }], false)).toBe(-1)
  })
})

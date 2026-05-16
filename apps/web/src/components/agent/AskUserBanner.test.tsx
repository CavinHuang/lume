import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentAskUserQuestionRequest } from '@lume/shared'

mock.module('@/lib/desktop-api', () => ({
  sidecarCall: async () => undefined,
  submitTaskApproval: async () => ({ ok: true }),
}))

const { AskUserBanner } = await import('./AskUserBanner')

const request: AgentAskUserQuestionRequest = {
  threadId: 'thread-1',
  toolUseId: 'ask-1',
  questions: [{
    header: '范围',
    question: '要先修哪部分?',
    options: [
      { label: '前端', description: '先修 UI' },
      { label: '后端', description: '先修 runtime' },
    ],
  }],
}

describe('AskUserBanner', () => {
  test('renders ask user questions with the same overlay frame language as plan approval', () => {
    const markup = renderToStaticMarkup(
      <AskUserBanner threadId="thread-1" request={request} />,
    )

    expect(markup).toContain('data-interactive-overlay="ask-user"')
    expect(markup).toContain('需要你的输入')
    expect(markup).toContain('要先修哪部分?')
    expect(markup).toContain('前端')
    expect(markup).toContain('后端')
    expect(markup).toContain('忽略')
    expect(markup).toContain('ESC')
    expect(markup).toContain('提交')
  })
})

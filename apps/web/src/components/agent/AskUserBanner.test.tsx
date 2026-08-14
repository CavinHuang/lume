import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentAskUserQuestionRequest } from '@lume/shared'

mock.module('@/lib/desktop-api', () => ({
  sidecarCall: async () => undefined,
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
  test('renders ask user questions with the redesigned decision frame', () => {
    const markup = renderToStaticMarkup(
      <AskUserBanner threadId="thread-1" request={request} />,
    )

    expect(markup).toContain('data-interactive-overlay="ask-user"')
    expect(markup).toContain('1 of 1')
    expect(markup).toContain('要先修哪部分?')
    expect(markup).toContain('前端')
    expect(markup).toContain('后端')
    expect(markup).toContain('都不合适，告诉 Lume 应该如何做得不同')
    expect(markup).toContain('跳过')
    expect(markup).toContain('ESC')
    expect(markup).not.toContain('提交回答')
  })
})

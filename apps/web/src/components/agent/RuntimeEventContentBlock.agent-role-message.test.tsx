import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('@lume/ui', () => ({
  useSmoothStream: ({ content }: { content: string }) => ({ displayedContent: content }),
}))

mock.module('@ant-design/x-markdown', () => ({
  XMarkdown: ({ children }: { children: React.ReactNode }) => (
    <article data-x-markdown="true">{children}</article>
  ),
}))

mock.module('@/lib/desktop-api', () => ({
  agentSend: async () => undefined,
  getThreadMessageVersions: async () => ({ messages: [] }),
}))

mock.module('./tool-result-renderers', () => ({
  ToolResultRenderer: () => null,
}))

const {
  UserAgentRoleInvocationContent,
  parseAgentRoleInstructionMessage,
} = await import('./RuntimeEventContentBlock') as typeof import('./RuntimeEventContentBlock') & {
  UserAgentRoleInvocationContent: React.ComponentType<{ text: string }>
}

describe('user agent role invocation messages', () => {
  test('parses the internal agent invocation instruction into display data', () => {
    const parsed = parseAgentRoleInstructionMessage(
      '请调用 Agent 工具，并将 subagent_type 设置为 "writer" 来处理这个任务：\n让它写',
    )

    expect(parsed?.role.id).toBe('writer')
    expect(parsed?.role.displayName).toBe('江岚')
    expect(parsed?.role.title).toBe('作家')
    expect(parsed?.task).toBe('让它写')
  })

  test('renders the agent avatar and name instead of leaking the internal instruction', () => {
    const markup = renderToStaticMarkup(
      <UserAgentRoleInvocationContent text={'请调用 Agent 工具，并将 subagent_type 设置为 "writer" 来处理这个任务：\n让它写'} />,
    )

    expect(markup).toContain('data-agent-role-message="writer"')
    expect(markup).toContain('writer')
    expect(markup).toContain('江岚')
    expect(markup).toContain('作家')
    expect(markup).toContain('让它写')
    expect(markup).not.toContain('请调用 Agent 工具')
    expect(markup).not.toContain('subagent_type')
  })
})

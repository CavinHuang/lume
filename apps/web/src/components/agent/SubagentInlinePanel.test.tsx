import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('@ant-design/x-markdown', () => ({
  XMarkdown: ({
    children,
    className,
    rootClassName,
  }: {
    children: React.ReactNode
    className?: string
    rootClassName?: string
  }) => (
    <section data-x-markdown="true" data-root-class={rootClassName ?? ''} className={className}>
      {children}
    </section>
  ),
}))

const {
  SubagentMarkdown,
  SubagentResultCard,
  SubagentHeader,
  isSubagentOutputTruncated,
  resolveSubagentHeaderAvatarSrc,
} = await import('./SubagentInlinePanel') as typeof import('./SubagentInlinePanel') & {
  SubagentMarkdown: React.ComponentType<{ output: string }>
  SubagentResultCard: React.ComponentType<{ output: string }>
  SubagentHeader: React.ComponentType<{
    label: string
    agentType: string
    isRunning: boolean
    isPending: boolean
    isDone: boolean
    isError: boolean
    elapsed: number
    expanded: boolean
    avatarSrc?: string
    onClick: () => void
  }>
  isSubagentOutputTruncated: (output: string) => boolean
  resolveSubagentHeaderAvatarSrc: (agentType: string) => string | undefined
}

describe('SubagentInlinePanel markdown output', () => {
  test('renders completed subagent output through the Markdown renderer', () => {
    const markup = renderToStaticMarkup(
      <SubagentMarkdown output={'**完成**\n\n| 项目 | 状态 |\n|---|---|\n| PO-1 | OK |'} />,
    )

    expect(markup).toContain('data-x-markdown="true"')
    expect(markup).toContain('data-root-class="x-markdown-light"')
    expect(markup).toContain('agent-message-markdown')
    expect(markup).toContain('| 项目 | 状态 |')
  })

  test('frames completed subagent output as a copyable result', () => {
    const markup = renderToStaticMarkup(
      <SubagentResultCard output={'## 完成\n\n这里是交付结果。'} />,
    )

    expect(markup).toContain('结果已完成')
    expect(markup).toContain('复制结果')
    expect(markup).toContain('data-x-markdown="true"')
    expect(markup).toContain('这里是交付结果。')
  })

  test('warns when completed subagent output looks truncated', () => {
    const output = '前半段\n...(truncated)...\n后半段'

    expect(isSubagentOutputTruncated(output)).toBe(true)
    expect(isSubagentOutputTruncated('完整结果')).toBe(false)

    const markup = renderToStaticMarkup(<SubagentResultCard output={output} />)

    expect(markup).toContain('data-subagent-output-truncated="true"')
    expect(markup).toContain('结果可能被截断')
  })

  test('renders a known agent avatar in the subagent header', () => {
    const avatarSrc = resolveSubagentHeaderAvatarSrc('writer')

    expect(avatarSrc).toContain('writer')

    const markup = renderToStaticMarkup(
      <SubagentHeader
        label="江岚 · 作家"
        agentType="writer"
        isRunning={false}
        isPending={false}
        isDone
        isError={false}
        elapsed={1200}
        expanded={false}
        avatarSrc={avatarSrc}
        onClick={() => undefined}
      />,
    )

    expect(markup).toContain('data-subagent-avatar="true"')
    expect(markup).toContain('江岚 · 作家')
    expect(markup).toContain('writer')
  })

  test('falls back to the bot icon when no agent avatar is available', () => {
    const markup = renderToStaticMarkup(
      <SubagentHeader
        label="Subagent"
        agentType="custom-agent"
        isRunning={false}
        isPending
        isDone={false}
        isError={false}
        elapsed={0}
        expanded={false}
        onClick={() => undefined}
      />,
    )

    expect(resolveSubagentHeaderAvatarSrc('custom-agent')).toBeUndefined()
    expect(markup).toContain('data-subagent-avatar-fallback="true"')
  })
})

import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const {
  SubagentHeader,
  resolveSubagentHeaderAvatarSrc,
} = await import('./SubagentInlinePanel') as typeof import('./SubagentInlinePanel') & {
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
  resolveSubagentHeaderAvatarSrc: (agentType: string) => string | undefined
}

describe('SubagentInlinePanel conversation output', () => {
  test('reuses the canonical runtime conversation projection and renderer', () => {
    const source = readFileSync(join(process.cwd(), 'apps/web/src/components/agent/SubagentInlinePanel.tsx'), 'utf8')

    expect(source).toContain('applyRuntimeEventsIncremental')
    expect(source).toContain('RuntimeEventContentBlock')
    expect(source).toContain('showAssistantAvatar={false}')
    expect(source).toContain('selectSubagentRunEvents')
    expect(source).not.toContain('SubagentLiveOutput')
    expect(source).not.toContain('publicText')
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

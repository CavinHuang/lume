import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = process.cwd()

function source(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8')
}

describe('RuntimeEvent UI boundary', () => {
  test('message entry points no longer write legacy run-event state', () => {
    const files = [
      'apps/web/src/components/agent/AgentInput.tsx',
      'apps/web/src/components/welcome/WelcomeView.tsx',
    ]

    for (const file of files) {
      const content = source(file)
      expect(content).not.toContain('agentRunEventsAtom')
      expect(content).not.toContain('appendRunEvent')
      expect(content).not.toContain('user_message_submitted')
    }
  })

  test('global listener no longer consumes legacy RUN_EVENT notifications', () => {
    const content = source('apps/web/src/hooks/useGlobalAgentListeners.ts')

    expect(content).not.toContain('agentRunEventsAtom')
    expect(content).not.toContain('appendRunEvent')
    expect(content).not.toContain('AGENT_IPC_CHANNELS.RUN_EVENT')
  })

  test('global listener refreshes thread list after sidecar appends a message', () => {
    const content = source('apps/web/src/hooks/useGlobalAgentListeners.ts')

    expect(content).toContain('case AGENT_IPC_CHANNELS.MESSAGE_APPENDED')
    expect(content).toContain('AGENT_IPC_CHANNELS.LIST_THREADS')
    expect(content).toContain('AGENT_IPC_CHANNELS.GET_THREAD_RUNTIME_EVENTS')
  })

  test('global listener clears pending tool permission after external permission resolution', () => {
    const content = source('apps/web/src/hooks/useGlobalAgentListeners.ts')

    expect(content).toContain("event.type === 'permission.resolved'")
    expect(content).toContain('removePendingToolPermissionEverywhere(prev, event.requestId)')
  })

  test('agent message projection has no legacy run-event projector', () => {
    expect(existsSync(join(repoRoot, 'apps/web/src/components/agent/run-event-message-projection.ts'))).toBeFalse()
    expect(existsSync(join(repoRoot, 'apps/web/src/components/agent/run-event-message-projection.test.ts'))).toBeFalse()
    expect(source('apps/web/src/components/agent/runtime-state-projections.ts')).not.toContain('LumeRunEvent')
  })

  test('runtime event UI uses RuntimeEvent naming at the product boundary', () => {
    expect(existsSync(join(repoRoot, 'apps/web/src/components/agent/RunEventContentBlock.tsx'))).toBeFalse()

    for (const file of [
      'apps/web/src/components/agent/AgentMessages.tsx',
      'apps/web/src/components/agent/runtime-state-projections.ts',
      'apps/web/src/components/agent/RuntimeEventContentBlock.tsx',
    ]) {
      expect(source(file)).not.toContain('RunEvent')
      expect(source(file)).not.toContain('run-event')
    }
  })

  test('agent transcript uses native scrolling for the hot scroll path', () => {
    const content = source('apps/web/src/components/agent/AgentMessages.tsx')

    expect(content).not.toContain('use-stick-to-bottom')
    expect(content).not.toContain('@/components/ui/scroll-area')
    expect(content).toContain('overflow-y-auto')
  })

  test('agent transcript avoids height-delta resize compensation on the streaming path', () => {
    const messages = source('apps/web/src/components/agent/AgentMessages.tsx')
    const contentBlock = source('apps/web/src/components/agent/RuntimeEventContentBlock.tsx')
    const subagentPanel = source('apps/web/src/components/agent/SubagentInlinePanel.tsx')

    expect(messages).toContain('bottomRef')
    expect(messages).toContain('scheduleBottomScroll')
    expect(messages).toContain('programmaticScrollUntilRef')
    expect(messages).not.toContain('getBoundingClientRect')
    expect(messages).not.toContain('getPreservedScrollTopAfterResize')
    expect(messages).toContain('suspendScrollCompensationForUserResize')
    expect(contentBlock).toContain('onUserResizeStart')
    expect(subagentPanel).toContain('onUserResizeStart')
  })

  test('subagent conversation follows streaming output only while the user stays near the bottom', () => {
    const subagentPanel = source('apps/web/src/components/agent/SubagentInlinePanel.tsx')

    expect(subagentPanel).toContain('isNearScrollBottom')
    expect(subagentPanel).toContain('shouldAutoScrollRef')
    expect(subagentPanel).toContain('scrollHeight')
    expect(subagentPanel).not.toContain('scrollTop = 0')
  })

  test('tool and subagent expansion use animated delayed-unmount panels', () => {
    const contentBlock = source('apps/web/src/components/agent/RuntimeEventContentBlock.tsx')
    const subagentPanel = source('apps/web/src/components/agent/SubagentInlinePanel.tsx')
    const animatedPanelPath = 'apps/web/src/components/agent/AnimatedCollapsiblePanel.tsx'
    const animatedPanelExists = existsSync(join(repoRoot, animatedPanelPath))
    const animatedPanel = animatedPanelExists ? source(animatedPanelPath) : ''

    expect(animatedPanelExists).toBeTrue()
    expect(contentBlock).toContain('AnimatedCollapsiblePanel')
    expect(contentBlock).toContain('useDeferredUnmount')
    expect(subagentPanel).toContain('AnimatedCollapsiblePanel')
    expect(subagentPanel).toContain('useDeferredUnmount')
    expect(subagentPanel).toContain('!expanded && !isPending && isDone')
    expect(animatedPanel).toContain('grid-rows-[0fr]')
    expect(animatedPanel).toContain('grid-rows-[1fr]')
    expect(animatedPanel).toContain('duration-300')
    expect(animatedPanel).toContain('visualOpen')
    expect(animatedPanel).toContain('requestAnimationFrame')
  })

  test('collapsed markdown previews do not mount full markdown renderers', () => {
    const contentBlock = source('apps/web/src/components/agent/RuntimeEventContentBlock.tsx')
    const subagentPanel = source('apps/web/src/components/agent/SubagentInlinePanel.tsx')

    expect(contentBlock).toContain('expanded &&')
    expect(contentBlock).not.toContain("expanded ? '' : 'max-h-[390px] overflow-hidden'")
    expect(subagentPanel).not.toContain('<SubagentMarkdown output={output} compact />')
  })

  test('stable markdown rendering stays centralized in the canonical message renderer', () => {
    const contentBlock = source('apps/web/src/components/agent/RuntimeEventContentBlock.tsx')
    const subagentPanel = source('apps/web/src/components/agent/SubagentInlinePanel.tsx')

    expect(contentBlock).toContain('const SmoothText = memo(')
    expect(subagentPanel).toContain('RuntimeEventContentBlock')
    expect(subagentPanel).not.toContain('SubagentMarkdown')
  })

  test('streaming markdown updates are throttled at the message renderer boundary', () => {
    const contentBlock = source('apps/web/src/components/agent/RuntimeEventContentBlock.tsx')

    expect(contentBlock).toContain('MARKDOWN_STREAM_MIN_DELAY_MS')
    expect(contentBlock).toContain('minDelay: MARKDOWN_STREAM_MIN_DELAY_MS')
  })
})

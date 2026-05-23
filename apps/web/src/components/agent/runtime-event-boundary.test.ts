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

  test('agent message projection has no legacy run-event projector', () => {
    expect(existsSync(join(repoRoot, 'apps/web/src/components/agent/run-event-message-projection.ts'))).toBeFalse()
    expect(existsSync(join(repoRoot, 'apps/web/src/components/agent/run-event-message-projection.test.ts'))).toBeFalse()
    expect(source('apps/web/src/components/agent/runtime-state-projections.ts')).not.toContain('LumeRunEvent')
  })

  test('runtime event UI uses RuntimeEvent naming at the product boundary', () => {
    expect(existsSync(join(repoRoot, 'apps/web/src/components/agent/RunEventContentBlock.tsx'))).toBeFalse()

    for (const file of [
      'apps/web/src/components/agent/AgentMessages.tsx',
      'apps/web/src/components/agent/TracePanel.tsx',
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

  test('user-expanded tool blocks skip regular list resize compensation', () => {
    const messages = source('apps/web/src/components/agent/AgentMessages.tsx')
    const contentBlock = source('apps/web/src/components/agent/RuntimeEventContentBlock.tsx')
    const subagentPanel = source('apps/web/src/components/agent/SubagentInlinePanel.tsx')

    expect(messages).toContain('suspendResizeCompensationUntilRef')
    expect(messages).toContain('suspendScrollCompensationForUserResize')
    expect(contentBlock).toContain('onUserResizeStart')
    expect(subagentPanel).toContain('onUserResizeStart')
    expect(subagentPanel).not.toContain('max-h-[min(70vh,720px)]')
    expect(subagentPanel).not.toContain('overflow-y-auto overscroll-contain')
    expect(subagentPanel).toContain('sticky top-0 z-10')
    expect(subagentPanel).not.toContain('overflow-anchor:none')
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
    expect(animatedPanel).toContain('duration-200')
    expect(animatedPanel).toContain('visualOpen')
    expect(animatedPanel).toContain('requestAnimationFrame')
  })
})

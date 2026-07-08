import { describe, expect, test } from 'bun:test'
import type { DesktopProactiveProposal } from '@lume/shared'
import type { Tab } from '@/atoms/tab-atoms'
import { buildDesktopProposalOpenRequestState, buildDesktopProposalWelcomeState } from './desktop-assistant-proposals-state'

const proposal: DesktopProactiveProposal = {
  id: 'proposal:snap-1',
  kind: 'reply',
  status: 'pending',
  snapshotId: 'snap-1',
  app: { id: 'wechat.exe', name: '微信' },
  window: { id: 'win:wechat', title: '项目群' },
  summary: '微信 中可能有一条需要回复的消息',
  createdAt: 1,
  expiresAt: 2,
}

describe('desktop assistant proposal state', () => {
  test('opens a proactive proposal as a welcome conversation with desktop context attached', () => {
    const tabs: Tab[] = [{ id: '__settings__', type: 'settings', title: '设置' }]

    expect(buildDesktopProposalWelcomeState({
      proposal,
      tabs,
      currentWorkspaceId: 'workspace-1',
    })).toEqual({
      activeTabId: '__welcome__',
      promptSeed: '请根据微信「项目群」里的当前上下文，帮我建议一条回复。',
      tabs: [
        {
          id: '__settings__',
          type: 'settings',
          title: '设置',
        },
        {
          id: '__welcome__',
          type: 'welcome',
          title: '处理微信建议',
          workspaceId: 'workspace-1',
          desktopContextTarget: {
            snapshotId: 'snap-1',
            app: { id: 'wechat.exe', name: '微信' },
            window: { id: 'win:wechat', title: '项目群' },
            capturedAt: 1,
          },
        },
      ],
    })
  })

  test('reuses the existing welcome tab and keeps prompts free of desktop text', () => {
    const tabs: Tab[] = [{
      id: '__welcome__',
      type: 'welcome',
      title: '新会话',
      workspaceId: 'workspace-old',
    }]

    const result = buildDesktopProposalWelcomeState({
      proposal: {
        ...proposal,
        summary: '客户问 password=secret 怎么处理',
      },
      tabs,
      currentWorkspaceId: null,
    })

    expect(result.tabs).toEqual([{
      id: '__welcome__',
      type: 'welcome',
      title: '处理微信建议',
      desktopContextTarget: {
        snapshotId: 'snap-1',
        app: { id: 'wechat.exe', name: '微信' },
        window: { id: 'win:wechat', title: '项目群' },
        capturedAt: 1,
      },
    }])
    expect(result.promptSeed).not.toContain('password=secret')
    expect(result.promptSeed).not.toContain('客户问')
  })

  test('opens a desktop notification click by proposal id without trusting notification text', () => {
    const result = buildDesktopProposalOpenRequestState({
      proposalId: 'proposal:snap-1',
      proposals: [proposal],
      tabs: [],
      currentWorkspaceId: 'workspace-1',
    })

    expect(result).toEqual({
      activeTabId: '__welcome__',
      promptSeed: '请根据微信「项目群」里的当前上下文，帮我建议一条回复。',
      proposal,
      tabs: [{
        id: '__welcome__',
        type: 'welcome',
        title: '处理微信建议',
        workspaceId: 'workspace-1',
        desktopContextTarget: {
          snapshotId: 'snap-1',
          app: { id: 'wechat.exe', name: '微信' },
          window: { id: 'win:wechat', title: '项目群' },
          capturedAt: 1,
        },
      }],
    })

    expect(buildDesktopProposalOpenRequestState({
      proposalId: 'missing',
      proposals: [proposal],
      tabs: [],
      currentWorkspaceId: 'workspace-1',
    })).toBeNull()
  })
})

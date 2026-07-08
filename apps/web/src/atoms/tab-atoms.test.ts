import { describe, expect, test } from 'bun:test'
import { setTabDesktopContextTarget, type Tab } from './tab-atoms'

describe('tab desktop context state', () => {
  test('persists the selected desktop app on the active agent tab', () => {
    const tabs: Tab[] = [
      { id: 'thread-1', type: 'agent', title: '会话', threadId: 'thread-1' },
      { id: 'settings', type: 'settings', title: '设置' },
    ]

    expect(setTabDesktopContextTarget(tabs, 'thread-1', {
      snapshotId: 'snap-wechat',
      app: { id: 'wechat.exe', name: '微信' },
      window: { id: 'win:wechat', title: '项目群' },
    })).toEqual([
      {
        id: 'thread-1',
        type: 'agent',
        title: '会话',
        threadId: 'thread-1',
        desktopContextTarget: {
          snapshotId: 'snap-wechat',
          app: { id: 'wechat.exe', name: '微信' },
          window: { id: 'win:wechat', title: '项目群' },
        },
      },
      { id: 'settings', type: 'settings', title: '设置' },
    ])
  })
})

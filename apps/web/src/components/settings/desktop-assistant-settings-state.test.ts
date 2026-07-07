import { describe, expect, test } from 'bun:test'
import type { DesktopAssistantSettings, DesktopAssistantStatus } from '@lume/shared'
import { buildDesktopAssistantDiagnostics } from './desktop-assistant-settings-state'

const enabledSettings: DesktopAssistantSettings = {
  enabled: true,
  allowedApps: ['WeChat.exe'],
  retentionHours: 24,
  maxStorageBytes: 2_000_000,
}

const readyStatus: DesktopAssistantStatus = {
  host: { status: 'ok' },
  store: { unlocked: true, items: 2, bytes: 1024 },
}

describe('desktop assistant settings state', () => {
  test('prioritizes desktop host failures as actionable errors', () => {
    expect(buildDesktopAssistantDiagnostics({
      settings: enabledSettings,
      status: {
        ...readyStatus,
        host: { status: 'unavailable', message: 'desktop host is offline' },
      },
    })).toEqual({
      tone: 'error',
      title: '桌面 Host 不可用',
      details: ['desktop host is offline'],
    })
  })

  test('warns when encrypted context storage is locked', () => {
    expect(buildDesktopAssistantDiagnostics({
      settings: enabledSettings,
      status: {
        ...readyStatus,
        store: { unlocked: false, items: 0, bytes: 0 },
      },
    })).toEqual({
      tone: 'warning',
      title: '本地加密存储未解锁',
      details: ['重启后需要 Electron 主进程完成安全密钥初始化，之后才能保留桌面快照。'],
    })
  })

  test('explains disabled collection and empty allowlist before reporting ready', () => {
    expect(buildDesktopAssistantDiagnostics({
      settings: { ...enabledSettings, enabled: false },
      status: readyStatus,
    }).title).toBe('后台桌面收集已关闭')

    expect(buildDesktopAssistantDiagnostics({
      settings: { ...enabledSettings, allowedApps: [] },
      status: readyStatus,
    }).title).toBe('应用白名单为空')

    expect(buildDesktopAssistantDiagnostics({
      settings: enabledSettings,
      status: readyStatus,
    })).toEqual({
      tone: 'ok',
      title: '桌面助手运行正常',
      details: ['Host 已连接，本地加密存储可用。'],
    })
  })
})

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
  collector: { running: true, suspensionReasons: [] },
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

  test('reports system suspension before collection settings', () => {
    expect(buildDesktopAssistantDiagnostics({
      settings: enabledSettings,
      status: {
        ...readyStatus,
        collector: { running: false, suspensionReasons: ['screen_locked'] },
      },
    })).toEqual({
      tone: 'warning',
      title: '桌面感知已暂停',
      details: ['系统处于锁屏状态；解锁后会自动恢复，不会在锁屏期间读取或保存桌面内容。'],
    })
  })

  test('shows the macOS computer-use permission target before generic host failures', () => {
    expect(buildDesktopAssistantDiagnostics({
      settings: enabledSettings,
      status: {
        ...readyStatus,
        host: {
          status: 'permission_denied',
          message: 'missing macOS permissions',
          permissionTarget: {
            appBundleName: 'Lume Computer Use.app',
            bundleId: 'com.lume.computer-use',
            authorizationSubject: 'appBundle',
          },
          permissions: [
            {
              id: 'accessibility',
              title: 'Accessibility',
              status: 'missing',
              instruction: '在 macOS 系统设置的 Accessibility 中添加并开启 Lume Computer Use.app，不要授权 Lume 主应用。',
            },
            { id: 'screenRecording', title: 'Screen & System Audio Recording', status: 'granted' },
          ],
        },
      } as DesktopAssistantStatus,
    })).toEqual({
      tone: 'error',
      title: '需要授权 Lume Computer Use.app',
      details: [
        '授权对象：Lume Computer Use.app（不是 Lume 主应用）。',
        '缺少权限：Accessibility。',
        '在 macOS 系统设置的 Accessibility 中添加并开启 Lume Computer Use.app，不要授权 Lume 主应用。',
      ],
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

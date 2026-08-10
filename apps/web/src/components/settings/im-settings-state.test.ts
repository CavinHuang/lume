import { describe, expect, test } from 'bun:test'
import {
  createImAccountDraft,
  formatCliAuthPhase,
  formatImAccountsEmptyCopy,
  formatSelectedWorkspaceName,
  formatWeixinQrImageSrc,
  formatWeixinLoginStatus,
  formatImStatusBadge,
  normalizeImAccountDraft,
  shouldKeepPollingCliAuth,
  shouldKeepPollingWeixinLogin,
} from './im-settings-state'

describe('im settings state', () => {
  test('formats empty account list copy', () => {
    expect(formatImAccountsEmptyCopy([])).toBe('暂无 IM 账号')
  })

  test('maps account status to compact badge labels', () => {
    expect(formatImStatusBadge('running')).toEqual({ label: '运行中', tone: 'success' })
    expect(formatImStatusBadge('auth_required')).toEqual({ label: '需重新认证', tone: 'warning' })
    expect(formatImStatusBadge('error')).toEqual({ label: '异常', tone: 'danger' })
  })

  test('normalizes draft fields before create or update', () => {
    expect(normalizeImAccountDraft({
      ...createImAccountDraft('workspace-1'),
      label: ' 工作微信 ',
      token: ' token-1 ',
      uin: ' 10001 ',
      baseUrl: ' https://ilink.example.com/ ',
      enabled: true,
    })).toEqual({
      provider: 'weixin',
      label: '工作微信',
      token: 'token-1',
      uin: '10001',
      baseUrl: 'https://ilink.example.com',
      workspaceId: 'workspace-1',
      enabled: true,
    })
  })

  test('normalizes dingtalk draft into accountKey + clientSecret', () => {
    expect(normalizeImAccountDraft({
      ...createImAccountDraft('workspace-1'),
      provider: 'dingtalk',
      label: ' 钉钉机器人 ',
      accountKey: ' dingxxxx ',
      token: ' secret-1 ',
      enabled: true,
    })).toEqual({
      provider: 'dingtalk',
      label: '钉钉机器人',
      accountKey: 'dingxxxx',
      token: 'secret-1',
      workspaceId: 'workspace-1',
      enabled: true,
    })
  })

  test('normalizes feishu draft into accountKey + token', () => {
    expect(normalizeImAccountDraft({
      ...createImAccountDraft('workspace-1'),
      provider: 'feishu',
      label: ' 飞书应用 ',
      accountKey: ' cli_xxx ',
      token: ' app-secret ',
      enabled: true,
    })).toEqual({
      provider: 'feishu',
      label: '飞书应用',
      accountKey: 'cli_xxx',
      token: 'app-secret',
      workspaceId: 'workspace-1',
      enabled: true,
    })
  })

  test('normalizes wecom draft into accountKey + token', () => {
    expect(normalizeImAccountDraft({
      ...createImAccountDraft('workspace-1'),
      provider: 'wecom',
      label: ' 企微机器人 ',
      accountKey: ' bot1 ',
      token: ' sec ',
      enabled: true,
    })).toEqual({
      provider: 'wecom',
      label: '企微机器人',
      accountKey: 'bot1',
      token: 'sec',
      workspaceId: 'workspace-1',
      enabled: true,
    })
  })

  test('falls back to the selected workspace when the draft has none', () => {
    expect(normalizeImAccountDraft({
      ...createImAccountDraft(),
      token: 'token-1',
    }, 'workspace-fallback')).toMatchObject({
      workspaceId: 'workspace-fallback',
    })
  })

  test('formats selected workspace name for the account dialog', () => {
    const workspaces = [
      { id: 'workspace-1', name: '产品工作区' },
      { id: 'workspace-2', name: '客服工作区' },
    ]
    expect(formatSelectedWorkspaceName(workspaces, 'workspace-2')).toBe('客服工作区')
    expect(formatSelectedWorkspaceName(workspaces, 'workspace-missing')).toBe('workspace-missing')
    expect(formatSelectedWorkspaceName([], '__none__')).toBe('未指定')
  })

  test('formats QR login status for the settings panel', () => {
    expect(formatWeixinLoginStatus({
      connected: false,
      status: 'need_verifycode',
      message: 'need code',
      needsVerifyCode: true,
    })).toEqual('需要输入手机微信显示的数字')
    expect(formatWeixinLoginStatus({
      connected: true,
      status: 'confirmed',
      message: 'ok',
    })).toEqual('微信已连接')
  })

  test('formats existing QR image content for direct rendering', () => {
    expect(formatWeixinQrImageSrc('data:image/png;base64,abc')).toBe('data:image/png;base64,abc')
    expect(formatWeixinQrImageSrc('iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(formatWeixinQrImageSrc('https://liteapp.weixin.qq.com/q/token')).toBeUndefined()
    expect(formatWeixinQrImageSrc()).toBeUndefined()
  })

  test('keeps QR polling only for active login statuses', () => {
    expect(shouldKeepPollingWeixinLogin({
      connected: false,
      status: 'wait',
      message: 'wait',
    })).toBe(true)
    expect(shouldKeepPollingWeixinLogin({
      connected: false,
      status: 'scaned',
      message: 'scaned',
    })).toBe(true)
    expect(shouldKeepPollingWeixinLogin({
      connected: false,
      status: 'need_verifycode',
      message: 'code',
      needsVerifyCode: true,
    })).toBe(false)
    expect(shouldKeepPollingWeixinLogin({
      connected: true,
      status: 'confirmed',
      message: 'ok',
    })).toBe(false)
  })

  test('maps CLI auth phase to compact badge labels', () => {
    expect(formatCliAuthPhase('connected')).toEqual({ label: '已授权', tone: 'success' })
    expect(formatCliAuthPhase('error')).toEqual({ label: '授权失败', tone: 'danger' })
    expect(formatCliAuthPhase('authorizing')).toEqual({ label: '授权中', tone: 'warning' })
    expect(formatCliAuthPhase(undefined)).toEqual({ label: '未授权', tone: 'neutral' })
  })

  test('keeps CLI polling only while authorizing', () => {
    expect(shouldKeepPollingCliAuth({ phase: 'authorizing' })).toBe(true)
    expect(shouldKeepPollingCliAuth({ phase: 'connected', profile: 'u1' })).toBe(false)
    expect(shouldKeepPollingCliAuth({ phase: 'error', error: '超时' })).toBe(false)
  })
})

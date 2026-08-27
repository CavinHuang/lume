import { describe, expect, test } from 'bun:test'
import {
  createImAccountDraft,
  formatCliAuthPhase,
  formatImAccountsEmptyCopy,
  formatImMirrorRowHint,
  formatSelectedWorkspaceName,
  formatWeixinQrImageSrc,
  formatWeixinLoginStatus,
  formatImStatusBadge,
  normalizeImAccountDraft,
  resolveImMirrorSwitchState,
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

describe('im-settings-state #544 会话镜像', () => {
  const feishuAccount = {
    id: 'acc-f',
    provider: 'feishu' as const,
    label: '飞书承担',
    enabled: true,
    status: 'running' as const,
    hasToken: true,
    baseUrl: '',
    createdAt: 0,
    updatedAt: 0
  }
  const dingtalkAccount = { ...feishuAccount, id: 'acc-d', provider: 'dingtalk' as const }

  test('镜像开关可用性：unsupported 渠道灰置带原因；未启用灰置；他人占用灰置；空闲可开', () => {
    expect(resolveImMirrorSwitchState({ account: dingtalkAccount, settings: null })).toMatchObject({
      disabled: true
    })
    expect(
      resolveImMirrorSwitchState({ account: dingtalkAccount, settings: null }).hint
    ).toContain('钉钉')

    const disabled = { ...feishuAccount, enabled: false }
    expect(resolveImMirrorSwitchState({ account: disabled, settings: null }).hint).toContain('未启用')

    const occupied = { enabledMirrorAccountId: 'acc-other' }
    expect(
      resolveImMirrorSwitchState({ account: feishuAccount, settings: occupied, ownerLabel: '别家' })
    ).toMatchObject({ disabled: true, hint: '由 别家 承担镜像' })

    expect(resolveImMirrorSwitchState({ account: feishuAccount, settings: null })).toEqual({
      disabled: false
    })
  })

  test('attach 档（weixin）：选择入口未开放前灰置带提示', () => {
    const weixinAccount = { ...feishuAccount, id: 'acc-w', provider: 'weixin' as const }
    const state = resolveImMirrorSwitchState({ account: weixinAccount, settings: null })
    expect(state.disabled).toBe(true)
    expect(state.hint).toContain('附着')
  })

  test('已承担者可关闭（自身不受占用/unsupported 灰置影响）', () => {
    const self = { enabledMirrorAccountId: 'acc-d' }
    expect(resolveImMirrorSwitchState({ account: dingtalkAccount, settings: self })).toEqual({
      disabled: false
    })
  })

  test('行内提示：承担者错误优先（danger），其次镜像计数（neutral），无则不渲染', () => {
    const owner = { enabledMirrorAccountId: 'acc-f' }
    expect(
      formatImMirrorRowHint({ account: feishuAccount, settings: { ...owner, lastError: '缺少 im:chat 权限' }, mirroredCount: 3 })
    ).toEqual({ tone: 'danger', text: '缺少 im:chat 权限' })
    expect(
      formatImMirrorRowHint({ account: feishuAccount, settings: owner, mirroredCount: 3 })
    ).toEqual({ tone: 'neutral', text: '已镜像 3 个会话' })
    expect(formatImMirrorRowHint({ account: feishuAccount, settings: owner, mirroredCount: 0 })).toBeNull()
    expect(formatImMirrorRowHint({ account: feishuAccount, settings: null, mirroredCount: 3 })).toBeNull()
  })
})

import { describe, expect, test } from 'bun:test'
import {
  createImAccountDraft,
  formatImAccountsEmptyCopy,
  formatWeixinLoginStatus,
  formatImStatusBadge,
  normalizeImAccountDraft,
  shouldKeepPollingWeixinLogin,
} from './im-settings-state'

describe('im settings state', () => {
  test('formats empty account list copy', () => {
    expect(formatImAccountsEmptyCopy([])).toBe('尚未链接微信账号')
  })

  test('maps account status to compact badge labels', () => {
    expect(formatImStatusBadge('running')).toEqual({ label: '运行中', tone: 'success' })
    expect(formatImStatusBadge('auth_required')).toEqual({ label: '需重新认证', tone: 'warning' })
    expect(formatImStatusBadge('error')).toEqual({ label: '异常', tone: 'danger' })
  })

  test('normalizes draft fields before create or update', () => {
    expect(normalizeImAccountDraft({
      ...createImAccountDraft(),
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
      enabled: true,
    })
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
})

import { describe, expect, test } from 'bun:test'
import {
  createImAccountDraft,
  formatImAccountsEmptyCopy,
  formatImStatusBadge,
  normalizeImAccountDraft,
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
})

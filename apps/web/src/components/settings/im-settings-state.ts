import type {
  ImAccount,
  ImAccountCreateInput,
  ImAccountStatus,
  ImWeixinLoginPollResult,
} from '@lume/shared'

export type ImStatusTone = 'neutral' | 'success' | 'warning' | 'danger'

export interface ImAccountDraft {
  provider: 'weixin'
  label: string
  token: string
  uin: string
  baseUrl: string
  enabled: boolean
}

export function createImAccountDraft(): ImAccountDraft {
  return {
    provider: 'weixin',
    label: '',
    token: '',
    uin: '',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    enabled: true,
  }
}

export function normalizeImAccountDraft(draft: ImAccountDraft): ImAccountCreateInput {
  return {
    provider: 'weixin',
    label: draft.label.trim(),
    token: draft.token.trim(),
    uin: draft.uin.trim(),
    baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''),
    enabled: draft.enabled,
  }
}

export function formatImAccountsEmptyCopy(accounts: ImAccount[]): string {
  return accounts.length === 0 ? '尚未链接微信账号' : ''
}

export function formatImStatusBadge(status: ImAccountStatus): { label: string; tone: ImStatusTone } {
  if (status === 'running') return { label: '运行中', tone: 'success' }
  if (status === 'starting') return { label: '启动中', tone: 'warning' }
  if (status === 'auth_required') return { label: '需重新认证', tone: 'warning' }
  if (status === 'error') return { label: '异常', tone: 'danger' }
  return { label: '已停止', tone: 'neutral' }
}

export function formatWeixinLoginStatus(result: ImWeixinLoginPollResult): string {
  if (result.connected) return '微信已连接'
  if (result.needsVerifyCode || result.status === 'need_verifycode') return '需要输入手机微信显示的数字'
  if (result.alreadyConnected) return '此微信已连接过'
  if (result.status === 'scaned') return '已扫码，请在手机微信确认'
  if (result.status === 'scaned_but_redirect') return '已扫码，正在切换登录节点'
  if (result.status === 'expired') return '二维码已过期'
  if (result.status === 'verify_code_blocked') return '验证码输入过多，请稍后重试'
  return result.message
}

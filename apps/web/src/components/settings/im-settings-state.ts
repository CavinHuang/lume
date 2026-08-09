import type {
  CliAuthPhase,
  CliAuthPollResult,
  ImAccount,
  ImAccountCreateInput,
  ImAccountStatus,
  ImProvider,
  ImWeixinLoginPollResult,
} from '@lume/shared'

export type ImStatusTone = 'neutral' | 'success' | 'warning' | 'danger'

export interface ImAccountDraft {
  provider: ImProvider
  label: string
  token: string // 微信=OpenClaw Token / 钉钉=ClientSecret / 飞书=AppSecret / 企微=Secret
  accountKey: string // 钉钉=ClientId / 飞书=AppId / 企微=BotId（微信不用）
  uin: string
  workspaceId: string
  baseUrl: string
  enabled: boolean
}

/**
 * 凭据型渠道(非微信)的表单字段标签。微信走扫码授权,不入此表。
 * 钉钉/飞书/企微统一用 accountKey + token 形态,仅标签与占位符不同。
 */
export const IM_PROVIDER_CREDENTIAL_FIELDS: Record<
  Exclude<ImProvider, 'weixin'>,
  { accountKey: string; token: string; placeholder: string }
> = {
  dingtalk: { accountKey: 'ClientId', token: 'ClientSecret', placeholder: 'dingxxxxxxxx' },
  feishu: { accountKey: 'App ID', token: 'App Secret', placeholder: 'cli_xxxxxxxx' },
  wecom: { accountKey: 'Bot ID', token: 'Secret', placeholder: 'xxxxxxxx' },
}

export function createImAccountDraft(workspaceId = ''): ImAccountDraft {
  return {
    provider: 'weixin',
    label: '',
    token: '',
    accountKey: '',
    uin: '',
    workspaceId,
    baseUrl: 'https://ilinkai.weixin.qq.com',
    enabled: true,
  }
}

export function normalizeImAccountDraft(draft: ImAccountDraft, fallbackWorkspaceId = ''): ImAccountCreateInput {
  const workspaceId = draft.workspaceId.trim() || fallbackWorkspaceId.trim()
  const base = {
    provider: draft.provider,
    label: draft.label.trim(),
    ...(workspaceId ? { workspaceId } : {}),
    enabled: draft.enabled,
  }
  if (draft.provider !== 'weixin') {
    // 凭据型渠道(钉钉/飞书/企微):统一 accountKey + token
    return {
      ...base,
      accountKey: draft.accountKey.trim(),
      token: draft.token.trim(),
    }
  }
  // 微信：沿用 token + 可选 baseUrl/uin
  return {
    ...base,
    token: draft.token.trim(),
    uin: draft.uin.trim(),
    baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''),
  }
}

export function formatImAccountsEmptyCopy(accounts: ImAccount[]): string {
  return accounts.length === 0 ? '暂无 IM 账号' : ''
}

export function formatSelectedWorkspaceName(
  workspaces: Array<{ id: string; name: string }>,
  workspaceId: string
): string {
  if (workspaceId === '__none__') return '未指定'
  return workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? workspaceId
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

export function formatWeixinQrImageSrc(value?: string): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  if (/^data:image\//i.test(trimmed)) return trimmed
  if (looksLikeImageBase64(trimmed)) return `data:image/png;base64,${trimmed}`
  return undefined
}

function looksLikeImageBase64(value: string): boolean {
  return /^(iVBORw0KGgo|\/9j\/|R0lGOD|UklGR|PHN2Z)/.test(value)
}

export function shouldKeepPollingWeixinLogin(result: ImWeixinLoginPollResult): boolean {
  return !result.connected
    && !result.alreadyConnected
    && result.status !== 'expired'
    && result.status !== 'need_verifycode'
    && result.status !== 'verify_code_blocked'
}

/** 企业渠道 CLI 授权相位 → 徽章(与微信登录 status→badge 对称) */
export function formatCliAuthPhase(phase?: CliAuthPhase): { label: string; tone: ImStatusTone } {
  if (phase === 'connected') return { label: '已授权', tone: 'success' }
  if (phase === 'error') return { label: '授权失败', tone: 'danger' }
  if (phase === 'authorizing') return { label: '授权中', tone: 'warning' }
  return { label: '未授权', tone: 'neutral' }
}

export function shouldKeepPollingCliAuth(result: CliAuthPollResult): boolean {
  return result.phase === 'authorizing'
}

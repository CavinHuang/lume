import * as React from 'react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import {
  ChevronDown,
  KeyRound,
  Link2,
  Loader2,
  MessageCircle,
  Play,
  Plus,
  QrCode,
  RefreshCw,
  Send,
  Square,
  Trash2,
  Unlink2,
  X,
} from 'lucide-react'
import {
  IM_MIRROR_TIERS,
  IM_PROVIDER_LABELS,
  type CliAuthPollResult,
  type ImAccount,
  type ImMirrorAttachCandidate,
  type ImMirrorEntryPublic,
  type ImMirrorSettingsPublic,
  type ImProvider,
} from '@lume/shared'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import {
  attachImMirror,
  cancelCliAuth,
  createImAccount,
  deleteImAccount,
  detachImMirror,
  getImMirrorSettings,
  listImAccounts,
  listImMirrorAttachCandidates,
  listImMirrors,
  listThreads,
  openExternal,
  pollCliAuth,
  pollWeixinLogin,
  setImMirrorOwner,
  startCliAuth,
  startImAccount,
  startWeixinLogin,
  stopImAccount,
  updateImAccount,
} from '@/lib/desktop-api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import {
  createImAccountDraft,
  formatCliAuthPhase,
  formatImAccountsEmptyCopy,
  formatSelectedWorkspaceName,
  formatImStatusBadge,
  formatWeixinQrImageSrc,
  formatWeixinLoginStatus,
  IM_PROVIDER_CREDENTIAL_FIELDS,
  normalizeImAccountDraft,
  formatImMirrorRowHint,
  resolveImMirrorSwitchState,
  shouldKeepPollingWeixinLogin,
  type ImAccountDraft,
  type ImStatusTone,
} from './im-settings-state'
import { ConnectorBrandIcon } from './connector-brand-icon'

/** IM provider → 品牌图标 service key(iconify 抽取集 + scripts/assets 官方标资产)。 */
const IM_PROVIDER_ICON_SERVICE: Partial<Record<ImProvider, string>> = {
  weixin: 'weixin',
  feishu: 'feishu',
  dingtalk: 'dingtalk',
  wecom: 'wecom',
}

function ProviderBrandIcon({ provider, size = 16 }: { provider: ImProvider; size?: number }) {
  const service = IM_PROVIDER_ICON_SERVICE[provider]
  if (!service) return <Send size={size} className="shrink-0 text-[var(--text-2)]" />
  return <ConnectorBrandIcon service={service} size={size} className="shrink-0" />
}

const toneClassName: Record<ImStatusTone, string> = {
  neutral: 'border-[var(--border)] text-[var(--text-2)]',
  success: 'border-[color:color-mix(in_oklab,var(--lume-success)_34%,var(--border))] bg-[color:color-mix(in_oklab,var(--lume-success)_8%,var(--surface-1))] text-[var(--lume-success)]',
  warning: 'border-[color:color-mix(in_oklab,var(--lume-warning)_34%,var(--border))] bg-[color:color-mix(in_oklab,var(--lume-warning)_8%,var(--surface-1))] text-[var(--lume-warning)]',
  danger: 'border-[color:color-mix(in_oklab,var(--lume-danger)_34%,var(--border))] bg-[color:color-mix(in_oklab,var(--lume-danger)_8%,var(--surface-1))] text-[var(--lume-danger)]',
}

const NO_WORKSPACE_VALUE = '__none__'

const PROVIDER_OPTIONS: ReadonlyArray<{ value: ImProvider; label: string; disabled?: boolean }> = [
  { value: 'weixin', label: IM_PROVIDER_LABELS.weixin },
  { value: 'dingtalk', label: IM_PROVIDER_LABELS.dingtalk },
  { value: 'feishu', label: IM_PROVIDER_LABELS.feishu },
  { value: 'wecom', label: IM_PROVIDER_LABELS.wecom },
]

/** 企业渠道:走 CLI OAuth 授权(微信走扫码,不入此列) */
const CLI_PROVIDERS = ['dingtalk', 'feishu', 'wecom'] as const

interface CliAuthSession extends CliAuthPollResult {
  sessionKey: string
  polling: boolean
}

export function ImSettings() {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const defaultWorkspace = workspaces.find((item) => item.id === currentWorkspaceId) ?? workspaces[0] ?? null
  const defaultWorkspaceId = defaultWorkspace?.id ?? ''
  const workspaceNames = React.useMemo(() => (
    new Map(workspaces.map((workspace) => [workspace.id, workspace.name]))
  ), [workspaces])

  const [collapsed, setCollapsed] = React.useState(false)
  const [accounts, setAccounts] = React.useState<ImAccount[]>([])
  const [mirrorSettings, setMirrorSettings] = React.useState<ImMirrorSettingsPublic | null>(null)
  const [mirrorEntries, setMirrorEntries] = React.useState<ImMirrorEntryPublic[]>([])
  const [mirrorTitles, setMirrorTitles] = React.useState<Record<string, string>>({})
  const [attachPanelAccountId, setAttachPanelAccountId] = React.useState<string | null>(null)
  const [attachCandidates, setAttachCandidates] = React.useState<ImMirrorAttachCandidate[]>([])
  const [attachChatId, setAttachChatId] = React.useState('')
  const [attachThreadId, setAttachThreadId] = React.useState('')
  const [attachBusy, setAttachBusy] = React.useState(false)
  const [attachThreads, setAttachThreads] = React.useState<Array<{ id: string; title: string }>>([])
  const [draft, setDraft] = React.useState<ImAccountDraft>(() => createImAccountDraft(defaultWorkspaceId))
  const [loading, setLoading] = React.useState(true)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [addDialogOpen, setAddDialogOpen] = React.useState(false)
  const [loginSession, setLoginSession] = React.useState<{
    sessionKey: string
    qrcodeUrl?: string
    qrcodeImageSrc?: string
    statusText: string
    verifyCode: string
    polling: boolean
    autoPolling: boolean
  } | null>(null)
  const [cliAuth, setCliAuth] = React.useState<Record<string, CliAuthSession>>({})

  const refresh = React.useCallback(async () => {
    setLoading(true)
    try {
      const [accountList, settings, mirrorList] = await Promise.all([
        listImAccounts(),
        getImMirrorSettings(),
        listImMirrors(),
      ])
      setAccounts(accountList)
      setMirrorSettings(settings)
      setMirrorEntries(mirrorList.entries)
      setMirrorTitles(mirrorList.titles)
    } catch (error) {
      console.error('[IM 设置] 加载失败:', error)
      toast.error('加载 IM 账号失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void refresh() }, [refresh])

  React.useEffect(() => {
    if (!defaultWorkspaceId) return
    setDraft((current) => current.workspaceId ? current : { ...current, workspaceId: defaultWorkspaceId })
  }, [defaultWorkspaceId])

  const updateDraft = (patch: Partial<ImAccountDraft>) => {
    setDraft((current) => ({ ...current, ...patch }))
  }

  const selectedWorkspaceId = draft.workspaceId || defaultWorkspaceId || NO_WORKSPACE_VALUE
  const selectedWorkspaceName = formatSelectedWorkspaceName(workspaces, selectedWorkspaceId)
  const qrImageSrc = loginSession?.qrcodeImageSrc ?? formatWeixinQrImageSrc(loginSession?.qrcodeUrl)
  const qrFallbackUrl = loginSession?.qrcodeUrl?.trim() || qrImageSrc
  const credentialFields = draft.provider !== 'weixin' ? IM_PROVIDER_CREDENTIAL_FIELDS[draft.provider] : null

  const resetAddDialog = React.useCallback(() => {
    setDraft(createImAccountDraft(defaultWorkspaceId))
    setLoginSession(null)
    setSaving(false)
  }, [defaultWorkspaceId])

  const workspaceNameForAccount = (account: ImAccount): string | undefined => {
    return account.workspaceId ? workspaceNames.get(account.workspaceId) ?? account.workspaceId : undefined
  }

  // ─── #544 会话镜像 ───
  const mirrorOwner = mirrorSettings?.enabledMirrorAccountId
    ? accounts.find((account) => account.id === mirrorSettings.enabledMirrorAccountId) ?? null
    : null
  const mirroredCount = mirrorOwner
    ? mirrorEntries.filter((entry) => entry.accountId === mirrorOwner.id).length
    : 0

  const handleToggleMirror = React.useCallback(async (account: ImAccount, next: boolean) => {
    setBusyId(account.id)
    try {
      const result = await setImMirrorOwner(next ? account.id : null)
      setMirrorSettings(result.settings)
      if (!result.ok) {
        toast.error(result.error ?? '开启会话镜像失败')
      }
    } catch (error) {
      console.error('[IM 设置] 镜像开关失败:', error)
      toast.error('镜像设置失败')
    } finally {
      setBusyId(null)
    }
  }, [])

  // ─── #544 attach 附着档：机器人已在的群 × 桌面线程 显式配对 ───
  const attachEntryTitle = (threadId: string): string => mirrorTitles[threadId] || threadId.slice(0, 8)

  const openAttachPanel = React.useCallback(async (account: ImAccount) => {
    setAttachPanelAccountId(account.id)
    setAttachBusy(true)
    try {
      const [candidates, threadList] = await Promise.all([
        listImMirrorAttachCandidates(account.id),
        listThreads() as Promise<Array<{ id: string; title: string; updatedAt?: number }>>,
      ])
      setAttachCandidates(candidates.candidates)
      setAttachChatId(candidates.candidates[0]?.peerId ?? '')
      setAttachThreadId('')
      setAttachThreads(
        [...threadList]
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
          .slice(0, 30)
          .map((thread) => ({ id: thread.id, title: thread.title || thread.id.slice(0, 8) }))
      )
    } catch (error) {
      console.error('[IM 设置] 附着候选加载失败:', error)
      toast.error('加载附着候选失败')
    } finally {
      setAttachBusy(false)
    }
  }, [])

  const handleAttach = React.useCallback(async (account: ImAccount) => {
    if (!attachChatId || !attachThreadId) {
      toast.error('请选择群与桌面线程')
      return
    }
    setAttachBusy(true)
    try {
      const result = await attachImMirror({ accountId: account.id, chatId: attachChatId, threadId: attachThreadId })
      if (!result.ok) {
        toast.error(result.error ?? '附着失败')
        return
      }
      toast.success('已附着：运行进度同步到此群，群内回复也将进入该桌面线程')
      setAttachPanelAccountId(null)
      await refresh()
    } catch (error) {
      console.error('[IM 设置] 附着失败:', error)
      toast.error('附着失败')
    } finally {
      setAttachBusy(false)
    }
  }, [attachChatId, attachThreadId, refresh])

  const handleDetach = React.useCallback(async (threadId: string) => {
    setAttachBusy(true)
    try {
      await detachImMirror(threadId)
      await refresh()
    } catch (error) {
      console.error('[IM 设置] 解除附着失败:', error)
      toast.error('解除附着失败')
    } finally {
      setAttachBusy(false)
    }
  }, [])

  const handleWorkspaceChange = (value: string | null) => {
    updateDraft({ workspaceId: value === NO_WORKSPACE_VALUE ? '' : value ?? '' })
  }

  const handleAddDialogOpenChange = (open: boolean) => {
    setAddDialogOpen(open)
    if (!open) resetAddDialog()
  }

  const handleCreate = async () => {
    const input = normalizeImAccountDraft(draft, defaultWorkspaceId)
    const providerLabel = IM_PROVIDER_LABELS[draft.provider]
    if (draft.provider !== 'weixin') {
      const fields = IM_PROVIDER_CREDENTIAL_FIELDS[draft.provider]
      if (!input.accountKey) {
        toast.error(`${fields.accountKey} 不能为空`)
        return
      }
      if (!input.token) {
        toast.error(`${fields.token} 不能为空`)
        return
      }
    } else if (!input.token) {
      toast.error('OpenClaw Token 不能为空')
      return
    }
    setSaving(true)
    try {
      await createImAccount(input)
      toast.success(`${providerLabel} 账号已链接`)
      setAddDialogOpen(false)
      resetAddDialog()
      await refresh()
    } catch (error) {
      console.error('[IM 设置] 创建失败:', error)
      toast.error(`链接${providerLabel}账号失败`)
    } finally {
      setSaving(false)
    }
  }

  const handleStartLogin = async () => {
    setSaving(true)
    try {
      const workspaceId = draft.workspaceId.trim() || defaultWorkspaceId
      const started = await startWeixinLogin(workspaceId ? { workspaceId } : {})
      setLoginSession({
        sessionKey: started.sessionKey,
        qrcodeUrl: started.qrcodeUrl,
        qrcodeImageSrc: started.qrcodeImageSrc,
        statusText: started.message,
        verifyCode: '',
        polling: false,
        autoPolling: true,
      })
      toast.success('微信二维码已生成')
    } catch (error) {
      console.error('[IM 设置] 生成二维码失败:', error)
      toast.error('生成微信二维码失败')
    } finally {
      setSaving(false)
    }
  }

  const pollLoginOnce = React.useCallback(async (session = loginSession) => {
    if (!session) return
    setLoginSession((current) => current ? { ...current, polling: true } : current)
    try {
      const result = await pollWeixinLogin({
        sessionKey: session.sessionKey,
        verifyCode: session.verifyCode || undefined,
      })
      const statusText = formatWeixinLoginStatus(result)
      setLoginSession((current) => current ? {
        ...current,
        polling: false,
        autoPolling: shouldKeepPollingWeixinLogin(result),
        statusText,
        verifyCode: result.needsVerifyCode ? current.verifyCode : '',
      } : current)
      if (result.connected || result.alreadyConnected) {
        toast.success(statusText)
        setAddDialogOpen(false)
        resetAddDialog()
        await refresh()
      }
    } catch (error) {
      console.error('[IM 设置] 轮询二维码失败:', error)
      toast.error('检查微信登录状态失败')
      setLoginSession((current) => current ? { ...current, polling: false } : current)
    }
  }, [loginSession, refresh])

  React.useEffect(() => {
    if (!loginSession?.autoPolling || loginSession.polling) return
    const timer = window.setTimeout(() => {
      void pollLoginOnce(loginSession)
    }, 2500)
    return () => window.clearTimeout(timer)
  }, [loginSession, pollLoginOnce])

  const pollCliAuthOnce = React.useCallback(async (provider: string, session: CliAuthSession) => {
    setCliAuth((current) => {
      const existing = current[provider]
      return existing ? { ...current, [provider]: { ...existing, polling: true } } : current
    })
    try {
      const result = await pollCliAuth({ sessionKey: session.sessionKey })
      setCliAuth((current) => {
        const existing = current[provider]
        return existing ? { ...current, [provider]: { ...result, sessionKey: session.sessionKey, polling: false } } : current
      })
      if (result.phase === 'connected') toast.success(`${IM_PROVIDER_LABELS[provider as ImProvider]} CLI 已授权`)
    } catch (error) {
      console.error('[IM 设置] 轮询 CLI 授权失败:', error)
      setCliAuth((current) => {
        const existing = current[provider]
        return existing
          ? { ...current, [provider]: { ...existing, phase: 'error', error: '轮询失败', polling: false } }
          : current
      })
    }
  }, [])

  const handleStartCliAuth = async (provider: string) => {
    try {
      const started = await startCliAuth({ provider: provider as ImProvider })
      if (started.error || !started.sessionKey) {
        toast.error(started.error || '启动授权失败')
        return
      }
      if (started.authUrl) await openExternal(started.authUrl)
      setCliAuth((current) => ({
        ...current,
        [provider]: { phase: 'authorizing', sessionKey: started.sessionKey, polling: false },
      }))
      toast.success(
        provider === 'dingtalk'
          ? '授权页面已在浏览器打开。如需管理员审批，可能需要等待最多 16 分钟，完成后此页面会自动变为已授权'
          : '授权页面已在浏览器打开，请在系统浏览器完成登录（约 5 分钟内有效）'
      )
    } catch (error) {
      console.error('[IM 设置] 启动 CLI 授权失败:', error)
      toast.error('启动授权失败')
    }
  }

  const handleCancelCliAuth = async (provider: string, sessionKey: string) => {
    try {
      await cancelCliAuth({ sessionKey })
    } catch (error) {
      console.error('[IM 设置] 取消 CLI 授权失败:', error)
    }
    setCliAuth((current) => {
      const next = { ...current }
      delete next[provider]
      return next
    })
  }

  React.useEffect(() => {
    const pending = Object.entries(cliAuth).filter(
      ([, session]) => session.phase === 'authorizing' && !session.polling,
    )
    if (pending.length === 0) return
    const timer = window.setTimeout(() => {
      for (const [provider, session] of pending) void pollCliAuthOnce(provider, session)
    }, 2500)
    return () => window.clearTimeout(timer)
  }, [cliAuth, pollCliAuthOnce])

  const handleToggleEnabled = async (account: ImAccount, enabled: boolean) => {
    setBusyId(account.id)
    try {
      await updateImAccount(account.id, { enabled })
      await refresh()
    } catch (error) {
      console.error('[IM 设置] 更新启用状态失败:', error)
      toast.error(`更新${IM_PROVIDER_LABELS[account.provider]}账号失败`)
    } finally {
      setBusyId(null)
    }
  }

  const handleStart = async (account: ImAccount) => {
    setBusyId(account.id)
    try {
      await startImAccount(account.id)
      toast.success(`${IM_PROVIDER_LABELS[account.provider]} 通道已启动`)
      await refresh()
    } catch (error) {
      console.error('[IM 设置] 启动失败:', error)
      toast.error(`启动${IM_PROVIDER_LABELS[account.provider]}通道失败`)
    } finally {
      setBusyId(null)
    }
  }

  const handleStop = async (account: ImAccount) => {
    setBusyId(account.id)
    try {
      await stopImAccount(account.id)
      toast.success(`${IM_PROVIDER_LABELS[account.provider]} 通道已停止`)
      await refresh()
    } catch (error) {
      console.error('[IM 设置] 停止失败:', error)
      toast.error(`停止${IM_PROVIDER_LABELS[account.provider]}通道失败`)
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (account: ImAccount) => {
    if (!confirm(
      `移除「${account.label}」将停止该通道，并解除其所有 IM 会话与对话的绑定（对话记录保留）。此操作不可撤销。`
    )) return
    setBusyId(account.id)
    try {
      await deleteImAccount(account.id)
      toast.success(`${IM_PROVIDER_LABELS[account.provider]} 账号已移除`)
      await refresh()
    } catch (error) {
      console.error('[IM 设置] 删除失败:', error)
      toast.error(`移除${IM_PROVIDER_LABELS[account.provider]}账号失败`)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="lume-panel">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          onClick={() => setCollapsed((prev) => !prev)}
        >
          <ChevronDown className={`size-4 shrink-0 text-[var(--text-3)] transition-transform ${collapsed ? '-rotate-90' : ''}`} />
          <div className="flex size-8 items-center justify-center rounded-[8px] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-2))] text-[var(--brand)]">
            <MessageCircle size={16} />
          </div>
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-[var(--text-1)]">IM 通道</h3>
            <p className="text-[12px] text-[var(--text-3)]">{accounts.length} 个账号</p>
          </div>
        </button>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => handleAddDialogOpenChange(true)}>
            <Plus />
            链接账号
          </Button>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            刷新
          </Button>
        </div>
      </div>

      {!collapsed && (
      <div className="p-4">
        <div className="space-y-2">
          {loading ? (
            <div className="flex h-28 items-center justify-center text-[13px] text-[var(--text-3)]">
              <Loader2 className="mr-2 size-4 animate-spin" />
              加载中
            </div>
          ) : accounts.length === 0 ? (
            <div className="lume-subpanel border-dashed p-6 text-center text-[13px] text-[var(--text-3)]">
              {formatImAccountsEmptyCopy(accounts)}
            </div>
          ) : accounts.map((account) => (
            <React.Fragment key={account.id}>
              <AccountRow
                account={account}
                workspaceName={workspaceNameForAccount(account)}
                provider={account.provider}
                busy={busyId === account.id}
                onToggleEnabled={handleToggleEnabled}
                onStart={handleStart}
                onStop={handleStop}
                onDelete={handleDelete}
                mirrorEnabled={mirrorSettings?.enabledMirrorAccountId === account.id}
                mirrorState={resolveImMirrorSwitchState({
                  account,
                  settings: mirrorSettings,
                  ownerLabel: mirrorOwner?.label
                })}
                mirrorHint={formatImMirrorRowHint({
                  account,
                  settings: mirrorSettings,
                  mirroredCount
                })}
                onToggleMirror={handleToggleMirror}
              />
              {IM_MIRROR_TIERS[account.provider].tier === 'attach' && account.enabled && (
                <AttachPanel
                  entries={mirrorEntries.filter((entry) => entry.accountId === account.id)}
                  entryTitle={attachEntryTitle}
                  open={attachPanelAccountId === account.id}
                  candidates={attachCandidates}
                  threads={attachThreads}
                  chatId={attachChatId}
                  threadId={attachThreadId}
                  busy={attachBusy}
                  onOpen={() => void openAttachPanel(account)}
                  onChatChange={setAttachChatId}
                  onThreadChange={setAttachThreadId}
                  onAttach={() => void handleAttach(account)}
                  onClose={() => setAttachPanelAccountId(null)}
                  onDetach={(threadId) => void handleDetach(threadId)}
                />
              )}
            </React.Fragment>
          ))}
          {!loading && accounts.length > 0 && mirrorOwner && (
            <div className="lume-subpanel px-3 py-2 text-[12px] text-[var(--text-3)]">
              会话镜像已开启：桌面线程将同步到 {IM_PROVIDER_LABELS[mirrorOwner.provider]} 账号「{mirrorOwner.label}」，群内回复可直接续聊原会话
              {mirrorSettings?.lastError && (
                <span className="ml-2 text-[var(--danger)]">{mirrorSettings.lastError}</span>
              )}
            </div>
          )}
        </div>
      </div>
      )}

      {!collapsed && (
      <div className="border-t border-[var(--border)] p-4">
        <div className="mb-2 flex items-baseline gap-2">
          <p className="text-[13px] font-semibold text-[var(--text-1)]">企业 CLI 能力</p>
          <p className="text-[12px] text-[var(--text-3)]">授权后 Agent 可使用官方 CLI 操作该渠道（发消息、查日历、读文档等）。授权为渠道级，一次即可</p>
        </div>
        <div className="space-y-2">
          {CLI_PROVIDERS.map((provider) => {
            const session = cliAuth[provider]
            const badge = formatCliAuthPhase(session?.phase)
            const authorizing = session?.phase === 'authorizing'
            return (
              <div key={provider} className="lume-subpanel flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <ProviderBrandIcon provider={provider} size={16} />
                  <span className="text-[13px] font-medium text-[var(--text-1)]">{IM_PROVIDER_LABELS[provider]}</span>
                  <Badge variant="outline" className={cn('rounded-[6px]', toneClassName[badge.tone])}>{badge.label}</Badge>
                  {session?.profile && <span className="truncate text-[12px] text-[var(--text-3)]">{session.profile}</span>}
                  {session?.error && (
                    <span className="truncate text-[12px] text-[var(--danger)]" title={session.error}>{session.error}</span>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => (authorizing && session
                    ? void handleCancelCliAuth(provider, session.sessionKey)
                    : void handleStartCliAuth(provider))}
                  disabled={session?.polling}
                >
                  {session?.polling ? <Loader2 className="animate-spin" /> : authorizing ? <Square /> : <KeyRound />}
                  {authorizing ? '取消' : session?.phase === 'connected' ? '重新授权' : '授权'}
                </Button>
              </div>
            )
          })}
        </div>
      </div>
      )}

      <Dialog open={addDialogOpen} onOpenChange={handleAddDialogOpenChange}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>链接{IM_PROVIDER_LABELS[draft.provider]}</DialogTitle>
            <DialogDescription>
              {draft.provider === 'weixin'
                ? '使用微信扫码授权，确认后会自动保存账号。'
                : `录入${IM_PROVIDER_LABELS[draft.provider]}的凭据，确认后保存账号。`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-2">
              <Label>渠道</Label>
              <Select
                value={draft.provider}
                onValueChange={(value) => updateDraft({ provider: value as ImProvider, accountKey: '', token: '' })}
              >
                <SelectTrigger className="h-8 w-full bg-[var(--surface-1)] text-[13px]">
                  <span className="truncate text-left">{IM_PROVIDER_LABELS[draft.provider]}</span>
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                      {option.label}
                      {option.disabled ? '（敬请期待）' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {draft.provider === 'weixin' && (
            <div className="lume-subpanel p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-[var(--text-1)]">扫码链接</p>
                  <p className="mt-0.5 text-[12px] text-[var(--text-3)]">链接到你的微信</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => void handleStartLogin()} disabled={saving}>
                  {saving ? <Loader2 className="animate-spin" /> : <QrCode />}
                  生成
                </Button>
              </div>
              {loginSession && (
                <div className="mt-3 space-y-2">
                  {qrImageSrc && (
                    <a
                      href={qrFallbackUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mx-auto flex size-[176px] items-center justify-center rounded-[8px] border border-[var(--border)] bg-white p-2 hover:bg-white"
                    >
                      <img
                        src={qrImageSrc}
                        alt="微信登录二维码"
                        className="size-full object-contain"
                      />
                    </a>
                  )}
                  {!qrImageSrc && qrFallbackUrl && (
                    <a
                      href={qrFallbackUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate rounded-[6px] border border-dashed border-[var(--border)] px-2 py-1.5 text-[12px] text-[var(--brand)] hover:bg-[var(--surface-2)]"
                    >
                      打开二维码链接
                    </a>
                  )}
                  <p className="text-[12px] leading-5 text-[var(--text-2)]">{loginSession.statusText}</p>
                  <div className="flex gap-2">
                    <Input
                      value={loginSession.verifyCode}
                      onChange={(event) => setLoginSession((current) => current ? { ...current, verifyCode: event.target.value } : current)}
                      placeholder="验证码"
                      className="h-8"
                    />
                    <Button variant="outline" size="sm" onClick={() => void pollLoginOnce()} disabled={loginSession.polling}>
                      {loginSession.polling ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                      检查
                    </Button>
                  </div>
                </div>
              )}
            </div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="im-workspace">工作区</Label>
              <Select
                value={selectedWorkspaceId}
                disabled={workspaces.length === 0}
                onValueChange={handleWorkspaceChange}
              >
                <SelectTrigger id="im-workspace" className="h-8 w-full bg-[var(--surface-1)] text-[13px]">
                  <span className="truncate text-left">{selectedWorkspaceName}</span>
                </SelectTrigger>
                <SelectContent>
                  {workspaces.length === 0 ? (
                    <SelectItem value={NO_WORKSPACE_VALUE}>未指定</SelectItem>
                  ) : workspaces.map((workspace) => (
                    <SelectItem key={workspace.id} value={workspace.id}>{workspace.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {draft.provider === 'weixin' && (
            <details className="lume-subpanel p-3">
              <summary className="cursor-pointer text-[13px] font-medium text-[var(--text-2)]">
                手动链接
              </summary>
              <div className="mt-3 grid gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="im-label">名称</Label>
                  <Input id="im-label" value={draft.label} onChange={(event) => updateDraft({ label: event.target.value })} placeholder="工作微信" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="im-token">OpenClaw Token</Label>
                  <Input id="im-token" type="password" value={draft.token} onChange={(event) => updateDraft({ token: event.target.value })} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="im-base-url">Base URL</Label>
                  <Input id="im-base-url" value={draft.baseUrl} onChange={(event) => updateDraft({ baseUrl: event.target.value })} />
                </div>
                <div className="lume-panel flex items-center justify-between px-3 py-2">
                  <span className="text-[13px] text-[var(--text-2)]">启用</span>
                  <Switch checked={draft.enabled} onCheckedChange={(enabled) => updateDraft({ enabled })} />
                </div>
                <Button onClick={() => void handleCreate()} disabled={saving}>
                  {saving ? <Loader2 className="animate-spin" /> : <Plus />}
                  手动链接
                </Button>
              </div>
            </details>
            )}

            {credentialFields && (
              <div className="lume-subpanel grid gap-3 p-3">
                <div className="grid gap-2">
                  <Label htmlFor="im-label">名称</Label>
                  <Input
                    id="im-label"
                    value={draft.label}
                    onChange={(event) => updateDraft({ label: event.target.value })}
                    placeholder={IM_PROVIDER_LABELS[draft.provider]}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="im-account-key">{credentialFields.accountKey}</Label>
                  <Input
                    id="im-account-key"
                    value={draft.accountKey}
                    onChange={(event) => updateDraft({ accountKey: event.target.value })}
                    placeholder={credentialFields.placeholder}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="im-token">{credentialFields.token}</Label>
                  <Input
                    id="im-token"
                    type="password"
                    value={draft.token}
                    onChange={(event) => updateDraft({ token: event.target.value })}
                  />
                </div>
                <div className="lume-panel flex items-center justify-between px-3 py-2">
                  <span className="text-[13px] text-[var(--text-2)]">启用</span>
                  <Switch checked={draft.enabled} onCheckedChange={(enabled) => updateDraft({ enabled })} />
                </div>
                <Button onClick={() => void handleCreate()} disabled={saving}>
                  {saving ? <Loader2 className="animate-spin" /> : <Plus />}
                  链接{IM_PROVIDER_LABELS[draft.provider]}
                </Button>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => handleAddDialogOpenChange(false)} disabled={saving}>
              取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function AccountRow({
  account,
  workspaceName,
  provider,
  busy,
  onToggleEnabled,
  onStart,
  onStop,
  onDelete,
  mirrorEnabled,
  mirrorState,
  mirrorHint,
  onToggleMirror,
}: {
  account: ImAccount
  workspaceName?: string
  provider: ImProvider
  busy: boolean
  onToggleEnabled: (account: ImAccount, enabled: boolean) => void
  onStart: (account: ImAccount) => void
  onStop: (account: ImAccount) => void
  onDelete: (account: ImAccount) => void
  mirrorEnabled: boolean
  mirrorState: { disabled: boolean; hint?: string }
  mirrorHint: { tone: ImStatusTone; text: string } | null
  onToggleMirror: (account: ImAccount, next: boolean) => void
}) {
  const badge = formatImStatusBadge(account.status)
  const accountMeta = [account.uin || account.id, workspaceName].filter(Boolean).join(' · ')
  return (
    <div className="lume-subpanel flex flex-wrap items-center gap-3 px-3 py-2.5">
      <ProviderBrandIcon provider={provider} size={16} />
      <div className="min-w-[160px] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-[var(--text-1)]">{account.label}</span>
          <Badge variant="outline" className={cn('rounded-[6px]', toneClassName[badge.tone])}>{badge.label}</Badge>
        </div>
        <p className="mt-1 text-[12px] text-[var(--text-3)]">{accountMeta}</p>
        {account.lastError && (
          <p className="mt-1 line-clamp-2 text-[12px] text-[var(--danger)]" title={account.lastError}>
            {account.lastError}
          </p>
        )}
        {mirrorHint && (
          <p
            className={cn(
              'mt-1 line-clamp-2 text-[12px]',
              mirrorHint.tone === 'danger' ? 'text-[var(--danger)]' : 'text-[var(--text-3)]'
            )}
            title={mirrorHint.text}
          >
            {mirrorHint.text}
          </p>
        )}
      </div>
      <Switch checked={account.enabled} onCheckedChange={(enabled) => onToggleEnabled(account, enabled)} disabled={busy} />
      <label
        className="flex items-center gap-1 text-[12px] text-[var(--text-3)]"
        title={mirrorState.hint ?? (mirrorEnabled ? '关闭会话镜像' : '把桌面线程镜像到该账号的 IM 群')}
      >
        镜像
        <Switch
          aria-label={`会话镜像-${account.label}`}
          checked={mirrorEnabled}
          disabled={busy || mirrorState.disabled}
          onCheckedChange={(next) => onToggleMirror(account, next)}
        />
      </label>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon-sm" onClick={() => void onStart(account)} disabled={busy || account.status === 'running'}>
          {busy ? <Loader2 className="animate-spin" /> : <Play />}
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => void onStop(account)} disabled={busy || account.status !== 'running'}>
          <Square />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => void onDelete(account)} disabled={busy}>
          <Trash2 />
        </Button>
      </div>
    </div>
  )
}

/** #544 attach 附着档子面板：已有群 × 桌面线程 显式配对（仅 attach 档账号渲染） */
function AttachPanel({
  entries,
  entryTitle,
  open,
  candidates,
  threads,
  chatId,
  threadId,
  busy,
  onOpen,
  onChatChange,
  onThreadChange,
  onAttach,
  onClose,
  onDetach,
}: {
  entries: ImMirrorEntryPublic[]
  entryTitle: (threadId: string) => string
  open: boolean
  candidates: ImMirrorAttachCandidate[]
  threads: Array<{ id: string; title: string }>
  chatId: string
  threadId: string
  busy: boolean
  onOpen: () => void
  onChatChange: (chatId: string) => void
  onThreadChange: (threadId: string) => void
  onAttach: () => void
  onClose: () => void
  onDetach: (threadId: string) => void
}) {
  return (
    <div className="lume-subpanel flex flex-col gap-2 border-t border-dashed px-3 py-2">
      {entries.map((entry) => (
        <div key={entry.threadId} className="flex items-center justify-between gap-2 text-[12px] text-[var(--text-3)]">
          <span className="flex min-w-0 items-center gap-1.5">
            <Link2 size={12} className="shrink-0" />
            <span className="truncate">
              {entryTitle(entry.threadId)} → {entry.chatId}
            </span>
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`解除附着-${entryTitle(entry.threadId)}`}
            onClick={() => onDetach(entry.threadId)}
            disabled={busy}
            title="解除附着（群与聊天记录保留）"
          >
            <Unlink2 />
          </Button>
        </div>
      ))}
      {open ? (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
            <span className="text-[12px] text-[var(--text-3)]">群</span>
            <Select value={chatId} onValueChange={(value) => onChatChange(value ?? '')}>
              <SelectTrigger className="h-8 w-full bg-[var(--surface-1)] text-[13px]">
                <span className="truncate text-left">
                  {candidates.find((candidate) => candidate.peerId === chatId)?.peerName || chatId || '暂无可附着群'}
                </span>
              </SelectTrigger>
              <SelectContent>
                {candidates.length === 0 ? (
                  <SelectItem value="__none__" disabled>
                    把机器人拉入群并发送一条消息后出现在这里
                  </SelectItem>
                ) : (
                  candidates.map((candidate) => (
                    <SelectItem key={candidate.peerId} value={candidate.peerId}>
                      {candidate.peerName || candidate.peerId}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
            <span className="text-[12px] text-[var(--text-3)]">线程</span>
            <Select value={threadId} onValueChange={(value) => onThreadChange(value ?? '')}>
              <SelectTrigger className="h-8 w-full bg-[var(--surface-1)] text-[13px]">
                <span className="truncate text-left">
                  {threads.find((thread) => thread.id === threadId)?.title || '选择要镜像的桌面线程'}
                </span>
              </SelectTrigger>
              <SelectContent>
                {threads.map((thread) => (
                  <SelectItem key={thread.id} value={thread.id}>
                    {thread.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-end gap-1">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              <X />
              取消
            </Button>
            <Button size="sm" onClick={onAttach} disabled={busy || !chatId || !threadId}>
              {busy ? <Loader2 className="animate-spin" /> : <Link2 />}
              附着
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button variant="ghost" size="sm" onClick={onOpen} disabled={busy} title="把某个桌面线程的运行同步到机器人已在的群">
            <Link2 />
            附着已有群
          </Button>
        </div>
      )}
    </div>
  )
}

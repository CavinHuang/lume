import * as React from 'react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import {
  Loader2,
  MessageCircle,
  Play,
  Plus,
  QrCode,
  RefreshCw,
  Square,
  Trash2,
} from 'lucide-react'
import { IM_PROVIDER_LABELS, type ImAccount, type ImProvider } from '@lume/shared'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import {
  createImAccount,
  deleteImAccount,
  listImAccounts,
  pollWeixinLogin,
  startWeixinLogin,
  startImAccount,
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
  formatImAccountsEmptyCopy,
  formatSelectedWorkspaceName,
  formatImStatusBadge,
  formatWeixinQrImageSrc,
  formatWeixinLoginStatus,
  IM_PROVIDER_CREDENTIAL_FIELDS,
  normalizeImAccountDraft,
  shouldKeepPollingWeixinLogin,
  type ImAccountDraft,
  type ImStatusTone,
} from './im-settings-state'

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

export function ImSettings() {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const defaultWorkspace = workspaces.find((item) => item.id === currentWorkspaceId) ?? workspaces[0] ?? null
  const defaultWorkspaceId = defaultWorkspace?.id ?? ''
  const workspaceNames = React.useMemo(() => (
    new Map(workspaces.map((workspace) => [workspace.id, workspace.name]))
  ), [workspaces])

  const [accounts, setAccounts] = React.useState<ImAccount[]>([])
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

  const refresh = React.useCallback(async () => {
    setLoading(true)
    try {
      setAccounts(await listImAccounts())
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
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-[8px] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-2))] text-[var(--brand)]">
            <MessageCircle size={16} />
          </div>
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-[var(--text-1)]">IM 通道</h3>
            <p className="text-[12px] text-[var(--text-3)]">{accounts.length} 个账号</p>
          </div>
        </div>
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
            <AccountRow
              key={account.id}
              account={account}
              workspaceName={workspaceNameForAccount(account)}
              busy={busyId === account.id}
              onToggleEnabled={handleToggleEnabled}
              onStart={handleStart}
              onStop={handleStop}
              onDelete={handleDelete}
            />
          ))}
        </div>
      </div>

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
  busy,
  onToggleEnabled,
  onStart,
  onStop,
  onDelete,
}: {
  account: ImAccount
  workspaceName?: string
  busy: boolean
  onToggleEnabled: (account: ImAccount, enabled: boolean) => void
  onStart: (account: ImAccount) => void
  onStop: (account: ImAccount) => void
  onDelete: (account: ImAccount) => void
}) {
  const badge = formatImStatusBadge(account.status)
  const accountMeta = [account.uin || account.id, workspaceName].filter(Boolean).join(' · ')
  return (
    <div className="lume-subpanel flex flex-wrap items-center gap-3 px-3 py-2.5">
      <div className="min-w-[160px] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-[var(--text-1)]">{account.label}</span>
          <Badge variant="outline" className={cn('rounded-[6px]', toneClassName[badge.tone])}>{badge.label}</Badge>
        </div>
        <p className="mt-1 text-[12px] text-[var(--text-3)]">{accountMeta}</p>
      </div>
      <Switch checked={account.enabled} onCheckedChange={(enabled) => onToggleEnabled(account, enabled)} disabled={busy} />
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

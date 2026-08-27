import * as React from 'react'
import { toast } from 'sonner'
import { ChevronDown, ExternalLink, Loader2, Mail, RefreshCw } from 'lucide-react'
import { ConnectorBrandIcon } from './connector-brand-icon'
import type { ConnectorSetupField, ConnectorSetupWithStatus } from '@lume/shared'
import {
  disconnectConnector,
  getConnectorSetups,
  getConnectorStatus,
  openExternal,
  saveConnectorClientConfig,
  saveConnectorCredential,
  startConnectorAuth,
} from '@/lib/desktop-api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** 状态色与 ImSettings 的 tone 体系一致。 */
const statusTone: Record<'connected' | 'authorizing' | 'error' | 'idle', string> = {
  connected: 'border-[color:color-mix(in_oklab,var(--lume-success)_34%,var(--border))] bg-[color:color-mix(in_oklab,var(--lume-success)_8%,var(--surface-1))] text-[var(--lume-success)]',
  authorizing: 'border-[color:color-mix(in_oklab,var(--lume-warning)_34%,var(--border))] bg-[color:color-mix(in_oklab,var(--lume-warning)_8%,var(--surface-1))] text-[var(--lume-warning)]',
  error: 'border-[color:color-mix(in_oklab,var(--lume-danger)_34%,var(--border))] bg-[color:color-mix(in_oklab,var(--lume-danger)_8%,var(--surface-1))] text-[var(--lume-danger)]',
  idle: 'border-[var(--border)] text-[var(--text-2)]',
}

type ConnectorTone = keyof typeof statusTone

function toneFor(setup: ConnectorSetupWithStatus): ConnectorTone {
  if (setup.lastError) return 'error'
  if (setup.authorizing) return 'authorizing'
  if (setup.connected) return 'connected'
  return 'idle'
}

const TONE_LABEL: Record<ConnectorTone, string> = {
  connected: '已连接',
  authorizing: '授权中…',
  error: '异常',
  idle: '未连接',
}

/** 邮箱连接器设置区:卡片完全由 provider definition 下发的向导描述渲染,布局对齐 IM 通道面板。 */
export function ConnectorSettings() {
  const [setups, setSetups] = React.useState<ConnectorSetupWithStatus[]>([])
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [collapsed, setCollapsed] = React.useState(false)
  // 请求代际:并发 refresh 后发先至时旧快照不得覆盖新状态
  const refreshGeneration = React.useRef(0)

  // stale-while-revalidate:刷新保留旧列表(卡片不卸载,输入中的表单不丢),
  // 仅头部按钮转圈;首次加载(列表为空)才显示整块 spinner。
  const refresh = React.useCallback(() => {
    const generation = ++refreshGeneration.current
    setLoading(true)
    void getConnectorSetups()
      .then((next) => {
        if (refreshGeneration.current !== generation) return
        setSetups(next)
        setLoadError(null)
      })
      .catch((error) => {
        if (refreshGeneration.current !== generation) return
        setLoadError(error instanceof Error ? error.message : String(error))
        // stale-while-revalidate 下有旧列表时错误框不再渲染,必须给显式反馈
        toast.error(`连接器刷新失败:${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        if (refreshGeneration.current === generation) setLoading(false)
      })
  }, [])

  React.useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <section className="lume-panel">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          aria-expanded={!collapsed}
          aria-controls="connector-settings-body"
          onClick={() => setCollapsed((prev) => !prev)}
        >
          <ChevronDown className={`size-4 shrink-0 text-[var(--text-3)] transition-transform ${collapsed ? '-rotate-90' : ''}`} />
          <div className="flex size-8 items-center justify-center rounded-[8px] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-2))] text-[var(--brand)]">
            <Mail size={16} />
          </div>
          <div className="min-w-0">
            <h3 className="text-body-lg font-semibold text-[var(--text-1)]">邮箱连接器</h3>
            <p className="text-ui text-[var(--text-3)]">
              {loadError && setups.length === 0 ? '加载失败' : `${setups.filter((setup) => setup.connected).length}/${setups.length} 个已连接`}
            </p>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refresh()} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            刷新
          </Button>
        </div>
      </div>

      {/* 常驻 + hidden 切换:折叠态卸载目标会让 aria-controls 悬空(严格 ARIA 缺陷,#794③) */}
      <div id="connector-settings-body" className="p-4" hidden={collapsed}>
        <div className="space-y-2">
          {setups.length === 0 && loading ? (
            <div className="flex h-28 items-center justify-center text-body text-[var(--text-3)]">
              <Loader2 className="mr-2 size-4 animate-spin" />
              加载中
            </div>
          ) : setups.length === 0 && loadError ? (
            <div className="lume-subpanel border-dashed p-6 text-center text-body text-[var(--lume-danger)]">
              连接器加载失败:{loadError}
            </div>
          ) : setups.map((setup) => (
            <ConnectorCard key={setup.service} setup={setup} onChanged={refresh} />
          ))}
        </div>
      </div>
    </section>
  )
}

function ConnectorCard({ setup, onChanged }: { setup: ConnectorSetupWithStatus; onChanged: () => void }) {
  const [status, setStatus] = React.useState<ConnectorSetupWithStatus>(setup)
  const [busy, setBusy] = React.useState(false)
  // 表单值:oauth2 型为 clientId/clientSecret,custom 型按 fields key
  const [values, setValues] = React.useState<Record<string, string>>({})

  React.useEffect(() => {
    // 本地熔断态(轮询失败写入的 authorizing:false + lastError)优先于 server 快照:
    // 父级 refresh/其他卡片 onChanged 的回灌不得把它冲回「授权中…」,否则
    // pollFailures 清零后再花一轮 2s×5 失败又一次 toast(#794②)。
    // 授权真正完成(connected)或用户重新发起(authorizing)时仍跟随 server 真相。
    setStatus((prev) => (
      prev.lastError && !prev.authorizing && !setup.authorizing && !setup.connected ? prev : setup
    ))
  }, [setup])

  // 浏览器授权进行中轮询状态
  const wasAuthorizing = React.useRef(false)
  React.useEffect(() => {
    if (setup.authKind !== 'oauth2' || !status.authorizing) return
    wasAuthorizing.current = true
    let pollFailures = 0
    const timer = setInterval(() => {
      void getConnectorStatus(setup.service)
        .then((next) => {
          pollFailures = 0
          setStatus((prev) => ({ ...prev, connected: next.connected, authorizing: next.authorizing, lastError: next.lastError }))
          // 授权完成的瞬间拉全量(含 accountLabel),不等用户手动刷新
          if (wasAuthorizing.current && !next.authorizing && next.connected) onChanged()
          if (!next.authorizing) wasAuthorizing.current = false
        })
        .catch((error) => {
          // 连续失败超阈值停轮询并告知:silent catch 会让徽章停在「授权中…」直到服务端超时
          pollFailures += 1
          if (pollFailures === 5) {
            clearInterval(timer)
            setStatus((prev) => ({ ...prev, authorizing: false, lastError: '状态轮询失败,请重试或重新发起授权' }))
            toast.error(`授权状态轮询失败:${error instanceof Error ? error.message : String(error)}`)
          }
        })
    }, 2000)
    return () => clearInterval(timer)
  }, [setup.authKind, setup.service, status.authorizing, onChanged])

  const formFields: ConnectorSetupField[] =
    setup.authKind === 'oauth2'
      ? [
          { key: 'clientId', label: 'Client ID', inputType: 'text', placeholder: 'xxxx.apps.googleusercontent.com' },
          { key: 'clientSecret', label: 'Client Secret', inputType: 'password', placeholder: 'GOCSPX-…' },
        ]
      : setup.fields
  const formComplete = formFields.every((field) => (values[field.key] ?? '').trim().length > 0)

  const handleSave = async () => {
    setBusy(true)
    try {
      const trimmed = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()]))
      if (setup.authKind === 'oauth2') {
        await saveConnectorClientConfig({ service: setup.service, clientId: trimmed.clientId!, clientSecret: trimmed.clientSecret! })
        const { authorizationUrl } = await startConnectorAuth(setup.service)
        await openExternal(authorizationUrl)
        setStatus((prev) => ({ ...prev, authorizing: true, lastError: undefined }))
      } else {
        // custom 型:保存即触发服务端连接测试,失败直接抛错
        await saveConnectorCredential({ service: setup.service, values: trimmed })
        // 仅成功后清空:失败保留输入,授权码不必重新抄写
        setValues({})
      }
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const handleDisconnect = async () => {
    setBusy(true)
    try {
      await disconnectConnector(setup.service)
      setStatus((prev) => ({ ...prev, connected: false, accountLabel: undefined }))
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '断开失败')
    } finally {
      setBusy(false)
    }
  }

  const tone = toneFor(status)

  return (
    <div className="lume-subpanel p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <ConnectorBrandIcon service={setup.service} size={16} className="shrink-0" />
          <span className="text-body font-semibold text-[var(--text-1)]">{status.displayName}</span>
          {status.accountLabel && status.connected ? (
            <span className="truncate text-ui text-[var(--text-3)]">{status.accountLabel}</span>
          ) : null}
        </div>
        <Badge variant="outline" className={`shrink-0 text-ui ${statusTone[tone]}`}>{TONE_LABEL[tone]}</Badge>
      </div>

      {/* 配置指引:OAuth 型渲染注册步骤,custom 型由字段 description 承载 */}
      {!status.connected ? (
        <>
          {status.clientSetup ? (
            <ol className="mt-2 space-y-0.5 pl-4 text-ui leading-5 text-[var(--text-3)] list-decimal">
              {status.clientSetup.steps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          ) : (
            status.fields.map((field) => (
              <p key={field.key} className="mt-1.5 text-ui leading-5 text-[var(--text-3)]">{field.description}</p>
            ))
          )}
          {status.clientSetup?.docsUrl ? (
            <button
              type="button"
              className="mt-1 inline-flex items-center gap-0.5 text-ui underline text-[var(--text-3)] hover:text-[var(--text-2)]"
              onClick={() => void openExternal(status.clientSetup!.docsUrl!)}
            >
              打开配置页面 <ExternalLink className="size-3" />
            </button>
          ) : null}
        </>
      ) : null}

      {status.lastError ? (
        <p className="mt-2 text-ui text-[var(--lume-danger)]">{status.lastError}</p>
      ) : null}

      {status.connected ? (
        <footer className="mt-2.5 flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void handleDisconnect()}>
            断开连接
          </Button>
        </footer>
      ) : (
        <div className="mt-2.5 grid gap-2.5 max-w-md">
          {formFields.map((field) => (
            <div key={field.key} className="grid gap-1">
              <Label htmlFor={`${setup.service}-${field.key}`} className="text-ui">{field.label}</Label>
              <Input
                id={`${setup.service}-${field.key}`}
                type={field.inputType === 'password' ? 'password' : 'text'}
                value={values[field.key] ?? ''}
                onChange={(event) => setValues((prev) => ({ ...prev, [field.key]: event.target.value }))}
                placeholder={field.placeholder}
              />
            </div>
          ))}
          <div>
            <Button
              size="sm"
              // 授权进行中禁止再次提交:二次发起会顶替当前流,旧授权页成死胡同
              disabled={busy || !formComplete || status.authorizing}
              onClick={() => void handleSave()}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {setup.authKind === 'oauth2' ? '保存并发起授权' : '连接并验证'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

import * as React from 'react'
import { toast } from 'sonner'
import { ExternalLink, Loader2, Mail } from 'lucide-react'
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

/** 连接器设置区:卡片完全由 provider definition 下发的向导描述渲染。 */
export function ConnectorSettings() {
  const [setups, setSetups] = React.useState<ConnectorSetupWithStatus[]>([])

  const refresh = React.useCallback(() => {
    void getConnectorSetups()
      .then(setSetups)
      .catch(() => {})
  }, [])

  React.useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <>
      {setups.map((setup) => (
        <ConnectorCard key={setup.service} setup={setup} onChanged={refresh} />
      ))}
    </>
  )
}

function ConnectorCard({ setup, onChanged }: { setup: ConnectorSetupWithStatus; onChanged: () => void }) {
  const [status, setStatus] = React.useState<ConnectorSetupWithStatus>(setup)
  const [busy, setBusy] = React.useState(false)
  // 表单值:oauth2 型为 clientId/clientSecret,custom 型按 fields key
  const [values, setValues] = React.useState<Record<string, string>>({})

  React.useEffect(() => {
    setStatus(setup)
  }, [setup])

  // 浏览器授权进行中轮询状态
  React.useEffect(() => {
    if (setup.authKind !== 'oauth2' || !status.authorizing) return
    const timer = setInterval(() => {
      void getConnectorStatus(setup.service)
        .then((next) =>
          setStatus((prev) => ({ ...prev, connected: next.connected, authorizing: next.authorizing, lastError: next.lastError })),
        )
        .catch(() => {})
    }, 2000)
    return () => clearInterval(timer)
  }, [setup.authKind, setup.service, status.authorizing])

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
        setStatus({ ...setup, connected: true })
        try {
          await saveConnectorCredential({ service: setup.service, values: trimmed })
        } catch (error) {
          setStatus(setup)
          throw error
        }
      }
      setValues({})
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

  return (
    <section className="lume-panel p-4 mb-4">
      <header className="flex items-center gap-2">
        <Mail className="size-4 text-[var(--text-2)]" />
        <h3 className="text-body font-medium text-[var(--text-1)]">{setup.displayName}</h3>
        {status.connected ? (
          <Badge variant="outline" className="text-caption">{status.accountLabel ?? '已连接'}</Badge>
        ) : status.authorizing ? (
          <Badge variant="outline" className="text-caption">授权中…</Badge>
        ) : null}
      </header>

      {/* 配置指引:OAuth 型渲染注册步骤,custom 型由字段 description 承载 */}
      {setup.clientSetup ? (
        <ol className="mt-2 space-y-1 text-caption leading-5 text-[var(--text-2)] list-decimal pl-4">
          {setup.clientSetup.steps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
      ) : null}
      {!setup.clientSetup && !status.connected
        ? setup.fields.map((field) => (
            <p key={field.key} className="mt-2 text-caption leading-5 text-[var(--text-2)]">{field.description}</p>
          ))
        : null}
      {setup.clientSetup?.docsUrl ? (
        <button
          type="button"
          className="mt-1 inline-flex items-center gap-0.5 text-caption underline text-[var(--text-2)]"
          onClick={() => void openExternal(setup.clientSetup!.docsUrl!)}
        >
          打开配置页面 <ExternalLink className="size-3" />
        </button>
      ) : null}

      {status.lastError ? (
        <p className="mt-2 text-caption text-[var(--lume-danger)]">{status.lastError}</p>
      ) : null}

      {status.connected ? (
        <footer className="mt-3">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void handleDisconnect()}>
            断开连接
          </Button>
        </footer>
      ) : (
        <div className="mt-3 grid gap-3 max-w-md">
          {formFields.map((field) => (
            <div key={field.key} className="grid gap-1.5">
              <Label htmlFor={`${setup.service}-${field.key}`} className="text-caption">{field.label}</Label>
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
            <Button size="sm" disabled={busy || !formComplete} onClick={() => void handleSave()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {setup.authKind === 'oauth2'
                ? '保存并发起授权'
                : '连接并验证'}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

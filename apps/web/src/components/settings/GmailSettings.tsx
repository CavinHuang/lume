import * as React from 'react'
import { toast } from 'sonner'
import { Loader2, Mail } from 'lucide-react'
import type { ConnectorStatus } from '@lume/shared'
import {
  disconnectConnector,
  getConnectorStatus,
  openExternal,
  startConnectorAuth,
  saveConnectorClientConfig,
} from '@/lib/desktop-api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const GMAIL_SERVICE = 'gmail'

export function GmailSettings() {
  const [status, setStatus] = React.useState<ConnectorStatus | null>(null)
  const [clientId, setClientId] = React.useState('')
  const [clientSecret, setClientSecret] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void getConnectorStatus(GMAIL_SERVICE)
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // 授权进行中轮询 status,connected 即完成
  React.useEffect(() => {
    if (!status?.authorizing) return
    const timer = setInterval(() => {
      void getConnectorStatus(GMAIL_SERVICE)
        .then((next) => setStatus(next))
        .catch(() => {})
    }, 2000)
    return () => clearInterval(timer)
  }, [status?.authorizing])

  const handleSaveConfig = async () => {
    if (!clientId.trim() || !clientSecret.trim()) return
    setBusy(true)
    try {
      setStatus(await saveConnectorClientConfig({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const handleStartAuth = async () => {
    setBusy(true)
    try {
      const { authorizationUrl } = await startConnectorAuth(GMAIL_SERVICE)
      await openExternal(authorizationUrl)
      setStatus((prev) => (prev ? { ...prev, authorizing: true, lastError: undefined } : prev))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '发起授权失败')
    } finally {
      setBusy(false)
    }
  }

  const handleDisconnect = async () => {
    setBusy(true)
    try {
      setStatus(await disconnectConnector(GMAIL_SERVICE))
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
        <h3 className="text-body font-medium text-[var(--text-1)]">Gmail</h3>
        {status?.connected ? (
          <Badge variant="outline" className="text-caption">{status.accountLabel ?? '已连接'}</Badge>
        ) : status?.authorizing ? (
          <Badge variant="outline" className="text-caption">授权中…</Badge>
        ) : null}
      </header>

      <p className="mt-2 text-caption leading-5 text-[var(--text-2)]">
        连接后 agent 可搜索、读取、发送邮件与管理标签。需要你自己的 Google OAuth client:
        在 <button type="button" className="underline" onClick={() => void openExternal('https://console.cloud.google.com/apis/credentials')}>
          Google Cloud Console
        </button>{' '}
        创建项目 → 启用 Gmail API → OAuth 同意屏(External/测试)添加自己为 Test user → 创建「桌面应用」类型凭据,把 client_id 与 client_secret 粘贴到下面。
      </p>

      {status?.lastError ? (
        <p className="mt-2 text-caption text-[var(--lume-danger)]">{status.lastError}</p>
      ) : null}

      {!status?.clientConfigured ? (
        <div className="mt-3 grid gap-3 max-w-md">
          <div className="grid gap-1.5">
            <Label htmlFor="gmail-client-id" className="text-caption">Client ID</Label>
            <Input
              id="gmail-client-id"
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              placeholder="xxxx.apps.googleusercontent.com"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="gmail-client-secret" className="text-caption">Client Secret</Label>
            <Input
              id="gmail-client-secret"
              type="password"
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
              placeholder="GOCSPX-…"
            />
          </div>
          <div>
            <Button size="sm" disabled={busy || !clientId.trim() || !clientSecret.trim()} onClick={() => void handleSaveConfig()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </div>
        </div>
      ) : (
        <footer className="mt-3 flex items-center gap-2">
          {!status.connected ? (
            <Button size="sm" disabled={busy || status.authorizing} onClick={() => void handleStartAuth()}>
              {status.authorizing ? <Loader2 className="size-4 animate-spin" /> : null}
              {status.authorizing ? '等待浏览器授权…' : '连接 Google 账号'}
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void handleDisconnect()}>
              断开连接
            </Button>
          )}
        </footer>
      )}
    </section>
  )
}

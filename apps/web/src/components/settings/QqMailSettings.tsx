import * as React from 'react'
import { toast } from 'sonner'
import { Loader2, Mail } from 'lucide-react'
import type { ConnectorStatus } from '@lume/shared'
import {
  disconnectConnector,
  getConnectorStatus,
  saveConnectorCredential,
} from '@/lib/desktop-api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const QQ_SERVICE = 'qq_mail'

export function QqMailSettings() {
  const [status, setStatus] = React.useState<ConnectorStatus | null>(null)
  const [email, setEmail] = React.useState('')
  const [authorizationCode, setAuthorizationCode] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void getConnectorStatus(QQ_SERVICE)
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const handleConnect = async () => {
    setBusy(true)
    try {
      // 服务端先跑连接测试(list_folders),失败直接抛错
      setStatus(await saveConnectorCredential({ service: QQ_SERVICE, values: { email: email.trim(), authorizationCode: authorizationCode.trim() } }))
      setAuthorizationCode('')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '连接失败')
    } finally {
      setBusy(false)
    }
  }

  const handleDisconnect = async () => {
    setBusy(true)
    try {
      setStatus(await disconnectConnector(QQ_SERVICE))
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
        <h3 className="text-body font-medium text-[var(--text-1)]">QQ 邮箱</h3>
        {status?.connected ? (
          <Badge variant="outline" className="text-caption">{status.accountLabel ?? '已连接'}</Badge>
        ) : null}
      </header>

      <p className="mt-2 text-caption leading-5 text-[var(--text-2)]">
        连接后 agent 可搜索、读取、发送邮件与管理文件夹。需要先在 QQ 邮箱网页版「设置 → 账号与安全」开启 IMAP/SMTP 服务,并使用 16 位授权码(非登录密码)。
      </p>

      {!status?.connected ? (
        <div className="mt-3 grid gap-3 max-w-md">
          <div className="grid gap-1.5">
            <Label htmlFor="qq-email" className="text-caption">邮箱地址</Label>
            <Input
              id="qq-email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="user@qq.com"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="qq-auth-code" className="text-caption">授权码</Label>
            <Input
              id="qq-auth-code"
              type="password"
              value={authorizationCode}
              onChange={(event) => setAuthorizationCode(event.target.value)}
              placeholder="16 位授权码"
            />
          </div>
          <div>
            <Button size="sm" disabled={busy || !email.trim() || authorizationCode.trim().length !== 16} onClick={() => void handleConnect()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              连接并验证
            </Button>
          </div>
        </div>
      ) : (
        <footer className="mt-3 flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void handleDisconnect()}>
            断开连接
          </Button>
        </footer>
      )}
    </section>
  )
}

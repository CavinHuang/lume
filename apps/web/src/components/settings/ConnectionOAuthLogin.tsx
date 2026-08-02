import { useEffect, useRef, useState } from 'react'
import type { ConnectionOAuthSessionStatus } from '@lume/shared'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  answerConnectionOAuthPrompt,
  cancelConnectionOAuthLogin,
  getConnectionOAuthLoginStatus,
  openExternal,
  startConnectionOAuthLogin,
} from '@/lib/desktop-api'

function oauthErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (message.includes('provider_unsupported')) return '该供应商暂不支持订阅账号登录。'
  if (message.includes('connection_changed')) return '登录期间连接配置已发生变化，请重新登录。'
  if (message.includes('credential_unavailable')) return '登录凭据不可用，请重新登录。'
  if (message.includes('session_not_found') || message.includes('prompt_stale')) return '登录会话已过期，请重新登录。'
  return message || '登录失败，请重试。'
}

export function ConnectionOAuthLogin({
  connectionId,
  onCompleted,
}: {
  connectionId: string
  onCompleted?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [session, setSession] = useState<ConnectionOAuthSessionStatus | null>(null)
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const openedUrl = useRef('')
  const completedSession = useRef('')

  const refresh = async (sessionId: string) => {
    const next = await getConnectionOAuthLoginStatus(sessionId)
    setSession(next)
    if (next.status === 'completed' && completedSession.current !== next.sessionId) {
      completedSession.current = next.sessionId
      onCompleted?.()
    }
    return next
  }

  useEffect(() => {
    if (!open || !session || (session.status !== 'running' && session.status !== 'waiting_for_user')) return
    const timer = window.setInterval(() => {
      void refresh(session.sessionId).catch((cause) => {
        setError(oauthErrorMessage(cause))
      })
    }, 750)
    return () => window.clearInterval(timer)
  }, [open, session?.sessionId, session?.status])

  const loginEvent = [...(session?.events ?? [])].reverse().find((item) => (
    item.type === 'auth_url' || item.type === 'device_code'
  ))
  const loginUrl = loginEvent?.type === 'auth_url'
    ? loginEvent.url
    : loginEvent?.type === 'device_code'
      ? loginEvent.verificationUri
      : ''

  useEffect(() => {
    if (!loginUrl || openedUrl.current === loginUrl) return
    openedUrl.current = loginUrl
    void openExternal(loginUrl)
  }, [loginUrl])

  const start = async () => {
    setError('')
    openedUrl.current = ''
    completedSession.current = ''
    setOpen(true)
    setStarting(true)
    try {
      setSession(await startConnectionOAuthLogin(connectionId))
    } catch (cause) {
      setError(oauthErrorMessage(cause))
    } finally {
      setStarting(false)
    }
  }

  const submitAnswer = async () => {
    if (!session?.prompt) return
    setError('')
    try {
      setSession(await answerConnectionOAuthPrompt(session.sessionId, session.prompt.id, answer))
      setAnswer('')
    } catch (cause) {
      setError(oauthErrorMessage(cause))
    }
  }

  const deviceCode = [...(session?.events ?? [])].reverse().find((event) => event.type === 'device_code')
  const progress = [...(session?.events ?? [])].reverse().find((event) => event.type === 'progress' || event.type === 'info')
  const loginActive = session?.status === 'running' || session?.status === 'waiting_for_user'

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => void start()} disabled={starting}>
        {starting ? '正在启动…' : '登录订阅账号'}
      </Button>
      <Dialog open={open} onOpenChange={(nextOpen) => {
        if (!nextOpen && loginActive && session) void cancelConnectionOAuthLogin(session.sessionId)
        setOpen(nextOpen)
      }}>
        <DialogContent showCloseButton={!loginActive}>
          <DialogHeader>
            <DialogTitle>登录模型账号</DialogTitle>
            <DialogDescription>登录在系统浏览器中完成，凭据加密保存在当前设备。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {deviceCode?.type === 'device_code' && (
              <div className="rounded-lg bg-muted p-3 text-sm">
                验证码：<span className="ml-1 font-mono text-base font-semibold tracking-wider">{deviceCode.userCode}</span>
              </div>
            )}
            {loginUrl && loginActive && (
              <Button type="button" variant="outline" size="sm" onClick={() => void openExternal(loginUrl)}>
                重新打开登录页面
              </Button>
            )}
            {progress && 'message' in progress && <p className="text-sm text-muted-foreground">{progress.message}</p>}
            {session?.prompt && (
              <div className="space-y-2">
                <p className="text-sm">{session.prompt.message}</p>
                {session.prompt.type === 'select' ? (
                  <Select value={answer} onValueChange={(value) => setAnswer(value ?? '')}>
                    <SelectTrigger><SelectValue placeholder="请选择" /></SelectTrigger>
                    <SelectContent>
                      {session.prompt.options?.map((option) => (
                        <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    type={session.prompt.type === 'secret' ? 'password' : 'text'}
                    value={answer}
                    placeholder={session.prompt.placeholder}
                    onChange={(event) => setAnswer(event.target.value)}
                  />
                )}
                <Button type="button" onClick={() => void submitAnswer()} disabled={!answer}>继续</Button>
              </div>
            )}
            {session?.status === 'running' && !session.prompt && <p className="text-sm text-muted-foreground">等待浏览器授权…</p>}
            {session?.status === 'completed' && <p className="text-sm text-emerald-600">账号已连接。</p>}
            {session?.status === 'failed' && <p className="text-sm text-destructive">{oauthErrorMessage(session.error ?? '登录失败')}</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            {session && loginActive ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void cancelConnectionOAuthLogin(session.sessionId)
                  setOpen(false)
                }}
              >
                取消
              </Button>
            ) : session?.status === 'failed' ? (
              <>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>稍后处理</Button>
                <Button type="button" onClick={() => void start()} disabled={starting}>
                  {starting ? '正在重试…' : '重新登录'}
                </Button>
              </>
            ) : (
              <Button type="button" onClick={() => setOpen(false)}>完成</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

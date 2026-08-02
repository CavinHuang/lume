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
import {
  getConnectionVaultStatus,
  setupConnectionVault,
  unlockConnectionVault,
} from '@/lib/desktop-api/channel'
import { useCallback, useEffect, useState } from 'react'

type VaultStatus = Awaited<ReturnType<typeof getConnectionVaultStatus>>

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('password_too_short')) return '密码至少需要 8 个字符。'
  if (message.includes('secure_storage_unavailable')) return '当前系统无法使用安全凭据存储。'
  if (message.includes('already_configured')) return '凭据保险库已经初始化，请重启 Lume。'
  if (message.includes('password_invalid')) return '本地密码不正确。'
  return '无法初始化凭据保险库，请重试。'
}

export function ConnectionVaultSetupDialog() {
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const loadStatus = useCallback(async () => {
    setError(null)
    setStatus(null)
    try {
      setStatus(await getConnectionVaultStatus())
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    getConnectionVaultStatus()
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const needsAttention = status === null || !status.configured || !status.unlocked
  if (!needsAttention && !error) return null

  const handleSetup = async () => {
    setError(null)
    if (password.length < 8) {
      setError('密码至少需要 8 个字符。')
      return
    }
    if (password !== confirmation) {
      setError('两次输入的密码不一致。')
      return
    }

    setSaving(true)
    try {
      setStatus(await setupConnectionVault(password))
      setPassword('')
      setConfirmation('')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  const handleUnlock = async () => {
    setError(null)
    if (!password) {
      setError('请输入初始化 Lume 时设置的本地密码。')
      return
    }
    setSaving(true)
    try {
      setStatus(await unlockConnectionVault(password))
      setPassword('')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  const configuredButLocked = status?.configured && !status.unlocked
  const secureStorageUnavailable = status && !status.secureStorageAvailable
  const statusLoadFailed = status === null && error !== null

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>保护模型连接凭据</DialogTitle>
          <DialogDescription>
            {configuredButLocked
              ? '凭据保险库未能随设备自动解锁。可以重新连接，仍失败时再重启 Lume。'
              : '设置一次本地密码，用于加密 API Key。以后启动会由当前设备自动解锁，查看明文时才需要再次输入密码。'}
          </DialogDescription>
        </DialogHeader>

        {!status && !error ? (
          <p className="text-sm text-muted-foreground">正在检查安全存储…</p>
        ) : statusLoadFailed ? (
          <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
        ) : configuredButLocked ? (
          <div className="space-y-4">
            <p className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
              设备自动解锁失败。输入首次初始化时设置的本地密码即可恢复，本次之后仍会继续尝试自动解锁。
            </p>
            <div className="space-y-2">
              <Label htmlFor="connection-vault-unlock-password">本地密码</Label>
              <Input
                id="connection-vault-unlock-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={saving}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleUnlock()
                }}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        ) : secureStorageUnavailable ? (
          <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            系统安全存储不可用，Lume 不会降级为明文或弱加密保存凭据。
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="connection-vault-password">本地密码</Label>
              <Input
                id="connection-vault-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="至少 8 个字符"
                disabled={saving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="connection-vault-confirmation">确认密码</Label>
              <Input
                id="connection-vault-confirmation"
                type="password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                disabled={saving}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleSetup()
                }}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        {configuredButLocked ? (
          <DialogFooter>
            <Button variant="outline" onClick={() => void loadStatus()} disabled={saving}>
              重试自动解锁
            </Button>
            <Button onClick={() => void handleUnlock()} disabled={saving || !password}>
              {saving ? '正在解锁…' : '使用密码解锁'}
            </Button>
          </DialogFooter>
        ) : statusLoadFailed ? (
          <DialogFooter>
            <Button variant="outline" onClick={() => void loadStatus()}>
              重新检查
            </Button>
          </DialogFooter>
        ) : !configuredButLocked && !secureStorageUnavailable && status ? (
          <DialogFooter>
            <Button onClick={() => void handleSetup()} disabled={saving}>
              {saving ? '正在设置…' : '设置并继续'}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

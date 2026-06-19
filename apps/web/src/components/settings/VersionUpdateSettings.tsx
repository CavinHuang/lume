import * as React from 'react'
import {
  Box,
  CheckCircle2,
  Clock3,
  CloudDownload,
  Download,
  Loader2,
  RotateCw,
  ShieldCheck,
  UploadCloud,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import type { GeneralSettings, UpdateGeneralSettingsInput } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  checkDesktopUpdate,
  downloadDesktopUpdate,
  getGeneralSettings,
  getLatestGitHubRelease,
  installDesktopUpdateAndRelaunch,
  updateGeneralSettings,
  type DesktopUpdateDownloadEvent,
  type DesktopUpdateInfo,
} from '@/lib/desktop-api'
import { cn } from '@/lib/utils'
import {
  getUpdateActionState,
  normalizeReleaseVersion,
  shouldAutoCheckUpdates,
  type VersionUpdateSnapshot,
  type VersionUpdateStatus,
} from './version-update-state'
import { APP_VERSION } from '@/lib/app-version'

const logoUrl = new URL('../../assets/imgs/logo.png', import.meta.url).href

interface DownloadProgress {
  downloadedBytes: number
  totalBytes: number | null
}

export function VersionUpdateSettings() {
  const [settings, setSettings] = React.useState<GeneralSettings | null>(null)
  const [latestVersion, setLatestVersion] = React.useState<string | null>(null)
  const [releaseBody, setReleaseBody] = React.useState('')
  const [releaseDate, setReleaseDate] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<VersionUpdateStatus>('idle')
  const [downloaded, setDownloaded] = React.useState(false)
  const [desktopUpdateAvailable, setDesktopUpdateAvailable] = React.useState(false)
  const [downloadProgress, setDownloadProgress] = React.useState<DownloadProgress>({
    downloadedBytes: 0,
    totalBytes: null,
  })
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  const autoCheckStartedRef = React.useRef(false)

  const snapshot: VersionUpdateSnapshot = {
    currentVersion: APP_VERSION,
    latestVersion,
    status,
    downloaded,
  }
  const actionState = getUpdateActionState(snapshot)
  const canDownload = actionState.canDownload && desktopUpdateAvailable
  const updateAvailable = status === 'available' || status === 'downloaded' || status === 'downloading'
  const lastCheckText = settings?.updateSettings.lastUpdateCheckAt
    ? formatDateTime(settings.updateSettings.lastUpdateCheckAt)
    : '尚未检查'

  React.useEffect(() => {
    let cancelled = false
    getGeneralSettings()
      .then((loaded) => {
        if (!cancelled) setSettings(loaded)
      })
      .catch((error) => {
        console.error('[VersionUpdateSettings] load settings FAILED:', error)
        toast.error('加载更新设置失败')
      })

    return () => {
      cancelled = true
    }
  }, [])

  const persistSettings = async (updates: UpdateGeneralSettingsInput) => {
    if (!settings) return
    const optimistic = {
      ...settings,
      updateSettings: {
        ...settings.updateSettings,
        ...updates.updateSettings,
      },
    }
    setSettings(optimistic)
    try {
      setSettings(await updateGeneralSettings(updates))
    } catch (error) {
      console.error('[VersionUpdateSettings] save settings FAILED:', error)
      setSettings(settings)
      toast.error('保存更新设置失败')
    }
  }

  const rememberCheckTime = async () => {
    await persistSettings({
      updateSettings: {
        lastUpdateCheckAt: new Date().toISOString(),
      },
    })
  }

  const applyUpdateInfo = (info: DesktopUpdateInfo | null, fallbackLatest: string | null) => {
    const remoteVersion = info?.version ?? fallbackLatest
    setDesktopUpdateAvailable(Boolean(info))
    setLatestVersion(remoteVersion ? normalizeReleaseVersion(remoteVersion) : null)
    setReleaseBody(info?.body ?? releaseBody)
    setReleaseDate(info?.date ?? releaseDate)
    setDownloaded(false)

    if (!remoteVersion) {
      setStatus('current')
      return
    }

    setStatus(
      normalizeReleaseVersion(remoteVersion) === normalizeReleaseVersion(APP_VERSION)
        ? 'current'
        : 'available'
    )
  }

  const handleCheckUpdate = async () => {
    setStatus('checking')
    setErrorMessage(null)
    try {
      const [desktopUpdate, latestRelease] = await Promise.all([
        checkDesktopUpdate().catch((error) => {
          console.warn('[VersionUpdateSettings] desktop updater unavailable:', error)
          return null
        }),
        getLatestGitHubRelease().catch((error) => {
          console.warn('[VersionUpdateSettings] release metadata unavailable:', error)
          return null
        }),
      ])
      setReleaseBody(desktopUpdate?.body ?? latestRelease?.body ?? '')
      setReleaseDate(desktopUpdate?.date ?? latestRelease?.published_at ?? null)
      applyUpdateInfo(desktopUpdate, latestRelease?.tag_name ?? null)
      await rememberCheckTime()
      toast.success(desktopUpdate || latestRelease ? '更新检查完成' : '当前已是最新版本')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorMessage(message)
      setStatus('error')
      toast.error('检查更新失败')
    }
  }

  React.useEffect(() => {
    if (!settings || autoCheckStartedRef.current) {
      return
    }
    if (!shouldAutoCheckUpdates(
      settings.updateSettings.autoCheckUpdates,
      settings.updateSettings.lastUpdateCheckAt,
      new Date()
    )) {
      return
    }
    autoCheckStartedRef.current = true
    void handleCheckUpdate()
  }, [settings])

  const handleDownloadUpdate = async () => {
    setStatus('downloading')
    setDownloadProgress({ downloadedBytes: 0, totalBytes: null })
    try {
      let downloadedBytes = 0
      let totalBytes: number | null = null
      await downloadDesktopUpdate((event: DesktopUpdateDownloadEvent) => {
        if (event.event === 'Started') {
          totalBytes = event.data.contentLength ?? null
          setDownloadProgress({ downloadedBytes: 0, totalBytes })
          return
        }
        if (event.event === 'Progress') {
          downloadedBytes += event.data.chunkLength
          setDownloadProgress({ downloadedBytes, totalBytes })
          return
        }
        setDownloadProgress((current) => ({
          downloadedBytes: current.totalBytes ?? current.downloadedBytes,
          totalBytes: current.totalBytes,
        }))
      })
      setDownloaded(true)
      setStatus('downloaded')
      if (settings?.updateSettings.notifyAfterDownload) {
        toast.success('更新已下载，可以安装并重启')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorMessage(message)
      setStatus('error')
      toast.error('下载更新失败')
    }
  }

  const handleInstallUpdate = async () => {
    setStatus('installing')
    try {
      await installDesktopUpdateAndRelaunch()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorMessage(message)
      setStatus('error')
      toast.error('安装更新失败')
    }
  }

  return (
    <div className="space-y-4 pb-6">
      <div className="grid grid-cols-4 gap-3">
        <MetricCard icon={Box} label="当前版本" value={APP_VERSION} tint="brand" />
        <MetricCard icon={CloudDownload} label="最新版本" value={latestVersion ?? '-'} tint="blue" />
        <MetricCard icon={UploadCloud} label="更新状态" value={getStatusLabel(status, updateAvailable)} tint={updateAvailable ? 'green' : 'brand'} />
        <MetricCard icon={Clock3} label="上次检查" value={lastCheckText} tint="violet" />
      </div>

      <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] p-5">
        <div className="flex items-center gap-5">
          <img src={logoUrl} alt="" className="size-20 rounded-[18px]" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-[20px] font-semibold text-[var(--text-1)]">Lume</h3>
              <span className="rounded-full bg-[color-mix(in_oklab,var(--brand)_12%,var(--surface-1))] px-2 py-0.5 text-[12px] font-medium text-[var(--brand)]">
                Stable
              </span>
            </div>
            <p className="mt-1 text-[13px] text-[var(--text-2)]">本地优先的 AI Agent 应用</p>
          </div>
          <div className="w-[300px] space-y-2 border-l border-[var(--border)] pl-8 text-[13px]">
            <InfoLine label="当前版本" value={APP_VERSION} />
            <InfoLine label="更新通道" value="Stable" />
            <InfoLine label="安装方式" value="桌面应用" />
          </div>
        </div>
      </section>

      <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] p-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-[15px] font-semibold text-[var(--text-1)]">更新详情</h3>
            <p className="mt-1 text-[13px] leading-5 text-[var(--text-2)]">
              {updateAvailable
                ? `Lume ${latestVersion} 可用`
                : status === 'current'
                  ? '当前版本已是最新'
                  : '检查 GitHub Release 与 Tauri 更新清单'}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="h-9 px-4" disabled={!actionState.canCheck} onClick={handleCheckUpdate}>
              <RotateCw size={15} />
              检查更新
            </Button>
            {canDownload && (
              <Button className="h-9 px-4" onClick={handleDownloadUpdate}>
                <Download size={15} />
                下载更新
              </Button>
            )}
            {actionState.canInstall && (
              <Button className="h-9 px-4" onClick={handleInstallUpdate}>
                <ShieldCheck size={15} />
                安装并重启
              </Button>
            )}
            {actionState.busyLabel && (
              <Button className="h-9 px-4" disabled>
                <Loader2 size={15} className="animate-spin" />
                {actionState.busyLabel}
              </Button>
            )}
          </div>
        </div>

        <div className="rounded-[8px] bg-[var(--surface-2)] p-4 text-[13px] leading-6 text-[var(--text-2)]">
          {errorMessage ? (
            <p className="text-[var(--danger)]">{errorMessage}</p>
          ) : releaseBody ? (
            <ReleaseNotes body={releaseBody} />
          ) : (
            <p>发布说明会在检查更新后显示。</p>
          )}
          {releaseDate && <p className="mt-3 text-[12px] text-[var(--text-3)]">发布于 {formatDate(releaseDate)}</p>}
        </div>
      </section>

      <div className="grid grid-cols-2 gap-4">
        <SettingsBox title="更新选项">
          <ToggleRow
            label="自动检查更新"
            desc="定期检查是否有新版本可用"
            checked={settings?.updateSettings.autoCheckUpdates ?? true}
            onCheckedChange={(checked) => void persistSettings({ updateSettings: { autoCheckUpdates: checked } })}
          />
          <ToggleRow
            label="下载完成后提醒"
            desc="下载完成后在系统托盘通知"
            checked={settings?.updateSettings.notifyAfterDownload ?? true}
            onCheckedChange={(checked) => void persistSettings({ updateSettings: { notifyAfterDownload: checked } })}
          />
        </SettingsBox>

        <SettingsBox title="安装保护">
          <ToggleRow
            label="仅在空闲时提示安装"
            desc="减少对当前工作的打扰"
            checked={settings?.updateSettings.installOnlyWhenIdle ?? true}
            onCheckedChange={(checked) => void persistSettings({ updateSettings: { installOnlyWhenIdle: checked } })}
          />
          <div className="flex items-center gap-2 rounded-[8px] bg-[color-mix(in_oklab,var(--brand)_7%,var(--surface-1))] px-3 py-2 text-[12px] text-[var(--text-2)]">
            <CheckCircle2 size={14} className="text-[var(--brand)]" />
            安装动作始终由用户确认触发
          </div>
        </SettingsBox>
      </div>

      {status === 'downloading' && (
        <DownloadOverlay progress={downloadProgress} version={latestVersion ?? ''} />
      )}
    </div>
  )
}

function MetricCard({
  icon: Icon,
  label,
  value,
  tint,
}: {
  icon: LucideIcon
  label: string
  value: string
  tint: 'brand' | 'blue' | 'green' | 'violet'
}) {
  const tintClass = {
    brand: 'bg-[color-mix(in_oklab,var(--brand)_12%,var(--surface-1))] text-[var(--brand)]',
    blue: 'bg-[color-mix(in_oklab,#3b82f6_13%,var(--surface-1))] text-[#2563eb]',
    green: 'bg-[color-mix(in_oklab,#22c55e_14%,var(--surface-1))] text-[#16a34a]',
    violet: 'bg-[color-mix(in_oklab,#8b5cf6_13%,var(--surface-1))] text-[#7c3aed]',
  }[tint]

  return (
    <div className="flex min-h-[96px] items-center gap-3 rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] px-4">
      <div className={cn('flex size-11 items-center justify-center rounded-full', tintClass)}>
        <Icon size={21} />
      </div>
      <div className="min-w-0">
        <p className="text-[12px] font-medium text-[var(--text-3)]">{label}</p>
        <p className="mt-1 truncate text-[18px] font-semibold text-[var(--text-1)]">{value}</p>
      </div>
    </div>
  )
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[var(--text-2)]">{label}</span>
      <span className="font-medium text-[var(--text-1)]">{value}</span>
    </div>
  )
}

function SettingsBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] p-5">
      <h3 className="text-[15px] font-semibold text-[var(--text-1)]">{title}</h3>
      {children}
    </section>
  )
}

function ToggleRow({
  label,
  desc,
  checked,
  onCheckedChange,
}: {
  label: string
  desc: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-[13px] font-medium text-[var(--text-1)]">{label}</p>
        <p className="mt-0.5 text-[12px] text-[var(--text-3)]">{desc}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

function ReleaseNotes({ body }: { body: string }) {
  const lines = body
    .split('\n')
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 5)

  if (lines.length === 0) {
    return <p>此版本没有发布说明。</p>
  }

  return (
    <ul className="list-disc space-y-1 pl-5">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  )
}

function DownloadOverlay({ progress, version }: { progress: DownloadProgress; version: string }) {
  const percent = progress.totalBytes
    ? Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
    : 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/10 backdrop-blur-[1px]">
      <div className="w-[496px] rounded-[12px] border border-[var(--border)] bg-[var(--surface-1)] p-6 shadow-[0_24px_80px_rgba(20,24,40,0.18)]">
        <div className="flex items-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]">
            <Download size={22} />
          </div>
          <div>
            <h3 className="text-[17px] font-semibold text-[var(--text-1)]">正在下载 Lume {version}</h3>
            <p className="mt-1 text-[13px] text-[var(--text-2)]">下载完成后可以选择稍后重启。</p>
          </div>
        </div>
        <div className="mt-6 h-2 overflow-hidden rounded-full bg-[var(--surface-3)]">
          <div className="h-full rounded-full bg-[var(--brand)] transition-all" style={{ width: `${percent}%` }} />
        </div>
        <p className="mt-3 text-[13px] text-[var(--text-2)]">
          {formatBytes(progress.downloadedBytes)}
          {progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ''}
          {progress.totalBytes ? ` · ${percent}%` : ''}
        </p>
      </div>
    </div>
  )
}

function getStatusLabel(status: VersionUpdateStatus, updateAvailable: boolean): string {
  if (status === 'checking') return '检查中'
  if (status === 'downloading') return '下载中'
  if (status === 'downloaded') return '已下载'
  if (status === 'installing') return '安装中'
  if (status === 'error') return '检查失败'
  if (updateAvailable) return '可更新'
  if (status === 'current') return '已是最新'
  return '未检查'
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

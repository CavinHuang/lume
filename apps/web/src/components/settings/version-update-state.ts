export type VersionUpdateStatus =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

export interface VersionUpdateSnapshot {
  currentVersion: string
  latestVersion: string | null
  status: VersionUpdateStatus
  downloaded: boolean
}

export interface VersionUpdateActionState {
  canCheck: boolean
  canDownload: boolean
  canInstall: boolean
  busyLabel: string | null
}

export interface ReleaseDownloadAsset {
  name: string
  browser_download_url: string
}

export interface ReleaseDownloadSource {
  assets?: ReleaseDownloadAsset[]
}

export type ReleaseDownloadPlatform = 'windows' | 'macos' | 'unknown'

export function normalizeReleaseVersion(version: string): string {
  return version.trim().replace(/^v/i, '')
}

export function getUpdateActionState(snapshot: VersionUpdateSnapshot): VersionUpdateActionState {
  if (snapshot.status === 'checking') {
    return {
      canCheck: false,
      canDownload: false,
      canInstall: false,
      busyLabel: '检查中...',
    }
  }

  if (snapshot.status === 'downloading') {
    return {
      canCheck: false,
      canDownload: false,
      canInstall: false,
      busyLabel: '下载中...',
    }
  }

  if (snapshot.status === 'installing') {
    return {
      canCheck: false,
      canDownload: false,
      canInstall: false,
      busyLabel: '安装中...',
    }
  }

  return {
    canCheck: true,
    canDownload: snapshot.status === 'available' && !snapshot.downloaded,
    canInstall: snapshot.status === 'downloaded' && snapshot.downloaded,
    busyLabel: null,
  }
}

export function pickReleaseText(
  desktopBody: string | undefined,
  githubBody: string | undefined,
  fallbackBody: string
): string {
  return desktopBody?.trim() || githubBody?.trim() || fallbackBody
}

export function shouldShowReleasePageAction(
  snapshot: VersionUpdateSnapshot,
  desktopUpdateAvailable: boolean,
  releaseUrl: string | null
): boolean {
  return getUpdateActionState(snapshot).canDownload && !desktopUpdateAvailable && Boolean(releaseUrl)
}

export function pickReleaseDownloadAsset(
  release: ReleaseDownloadSource | null | undefined,
  platform: ReleaseDownloadPlatform
): ReleaseDownloadAsset | null {
  const assets = release?.assets ?? []
  const downloadable = assets.filter((asset) => {
    const name = asset.name.toLowerCase()
    return asset.browser_download_url && !name.endsWith('.sig') && name !== 'latest.json'
  })

  if (platform === 'windows') {
    return (
      downloadable.find((asset) => {
        const name = asset.name.toLowerCase()
        return name.endsWith('.exe') && name.includes('setup')
      }) ??
      downloadable.find((asset) => asset.name.toLowerCase().endsWith('.exe')) ??
      downloadable.find((asset) => asset.name.toLowerCase().endsWith('.msi')) ??
      null
    )
  }

  if (platform === 'macos') {
    return downloadable.find((asset) => asset.name.toLowerCase().endsWith('.dmg')) ?? null
  }

  return null
}

export function shouldAutoCheckUpdates(
  autoCheckUpdates: boolean,
  lastUpdateCheckAt: string | null,
  now: Date
): boolean {
  if (!autoCheckUpdates) {
    return false
  }
  if (!lastUpdateCheckAt) {
    return true
  }

  const lastCheck = new Date(lastUpdateCheckAt)
  if (Number.isNaN(lastCheck.getTime())) {
    return true
  }

  return now.getTime() - lastCheck.getTime() >= 24 * 60 * 60 * 1000
}

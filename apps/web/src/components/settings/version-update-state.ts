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

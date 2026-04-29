import { getVersion } from '@tauri-apps/api/app'
import { relaunch } from '@tauri-apps/plugin-process'
import { check, type Update } from '@tauri-apps/plugin-updater'

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}

export type AppUpdateCheckResult =
  | {
      available: false
      currentVersion: string
      latestVersion?: string
      checkedAt: Date
    }
  | {
      available: true
      currentVersion: string
      latestVersion: string
      date?: string
      body?: string
      checkedAt: Date
    }

export type AppUpdateDownloadEvent = {
  progress: number
  downloaded: number
  total: number
  chunkLength?: number
}

let pendingUpdate: Update | null = null

export function isTauriRuntime() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__)
}

export async function getCurrentAppVersion() {
  if (!isTauriRuntime()) {
    return '0.1.0'
  }

  return getVersion()
}

export async function checkForAppUpdate(): Promise<AppUpdateCheckResult> {
  const currentVersion = await getCurrentAppVersion()

  if (!isTauriRuntime()) {
    pendingUpdate = null
    return {
      available: true,
      currentVersion,
      latestVersion: '0.1.1',
      date: '2026-04-29',
      body: '- 优化 Agent 会话体验\n- 修复模型供应商配置问题\n- 改进 MCP 设置与稳定性',
      checkedAt: new Date(),
    }
  }

  const update = await check()
  pendingUpdate = update ?? null

  if (!update) {
    return {
      available: false,
      currentVersion,
      checkedAt: new Date(),
    }
  }

  return {
    available: true,
    currentVersion,
    latestVersion: update.version,
    date: update.date,
    body: update.body,
    checkedAt: new Date(),
  }
}

export async function downloadPendingAppUpdate(
  onProgress?: (event: AppUpdateDownloadEvent) => void
) {
  if (!pendingUpdate) {
    throw new Error('No pending update available')
  }

  let downloaded = 0
  let total = 0

  await pendingUpdate.download((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? 0
      downloaded = 0
      onProgress?.({ progress: 0, downloaded, total })
      return
    }

    if (event.event === 'Progress') {
      downloaded += event.data.chunkLength
      const progress = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0
      onProgress?.({ progress, downloaded, total, chunkLength: event.data.chunkLength })
      return
    }

    if (event.event === 'Finished') {
      onProgress?.({ progress: 100, downloaded: total || downloaded, total: total || downloaded })
    }
  })
}

export async function installPendingAppUpdate() {
  if (!pendingUpdate) {
    throw new Error('No pending update available')
  }

  await pendingUpdate.install()
}

export async function restartAppForUpdate() {
  await relaunch()
}

export function formatUpdateCheckedAt(date: Date) {
  const now = new Date()
  const sameDay =
    now.getFullYear() === date.getFullYear() &&
    now.getMonth() === date.getMonth() &&
    now.getDate() === date.getDate()
  const time = date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

  return `${sameDay ? '今天' : date.toLocaleDateString('zh-CN')} ${time}`
}

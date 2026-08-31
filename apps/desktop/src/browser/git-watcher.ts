/**
 * Git 面板工作区文件 watch —— main 进程侧 fs.watch 实时刷新源。
 *
 * 对齐 ZCode GitAutoRefresh（docs/analysis/P2-git-codeviewer.md §1.4）的 host
 * fileWatcherService：监听工作区目录（递归）+ `.git` 目录（工作区是仓库根的
 * 子目录时 `.git` 不在递归范围内，ZCode 同为两个 watch 路径），任一变更 →
 * 单定时器 60s 防抖（每次事件重置）→ emit `lume:browser-git-dirty`，renderer
 * GitPanel 据此递增 revision 重载 status 并失效 diff 缓存。60s 轮询保留兜底，
 * watch 是比轮询快的加速通道。
 *
 * 生命周期：同时只 watch 一个工作区（watchWorkspace 替换旧监听，同
 * terminal-create 的单 PTY 形态）；路径由 renderer 经 lume:browser-git-watch
 * 告知（main 不感知 agent workspaces 的 projectPath）。
 *
 * 失败面（与 sidecar workspace-watcher 同口径）：目标不存在直接跳过；
 * fs.watch 同步抛错或异步 error（目录被删/移走等，Windows 报 EPERM）→
 * 自清理 + warn，信号失效可接受，不威胁宿主进程存活。
 */

import { existsSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { GIT_PANEL_IPC_CHANNELS } from '@lume/shared'
import type { BrowserEventSink } from './core/types'

/** 变更防抖窗口（ZCode GitAutoRefresh Tpe = 6e4）。 */
const DEFAULT_DEBOUNCE_MS = 60_000

export interface GitWorkspaceWatcherOptions {
  /** 事件出口：经宿主 forwardBrowserEvent 加 `lume:event:` 前缀发往 renderer。 */
  emit: BrowserEventSink
  /** 主窗口探针：无存活窗口时丢弃到期的 dirty 通知。 */
  getWindow: () => BrowserWindow | null
  /** 告警出口（watch 失败自清理时记录；缺省 console.warn）。 */
  warn?: (message: string, error?: unknown) => void
  /** 防抖窗口（单测可调短；生产缺省 60s 与 ZCode 一致）。 */
  debounceMs?: number
}

export interface GitWorkspaceWatcher {
  /** 监听工作区目录 + `.git` 目录（递归）；替换已有监听（同时只一个工作区）。 */
  watchWorkspace(workspacePath: string): void
  /** 关闭全部监听并丢弃在途防抖。 */
  unwatchAll(): void
}

export function createGitWorkspaceWatcher(options: GitWorkspaceWatcherOptions): GitWorkspaceWatcher {
  const warn = options.warn ?? ((message: string, error?: unknown) => console.warn(message, error))
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  let watchers: FSWatcher[] = []
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const clearDebounce = (): void => {
    if (!debounceTimer) return
    clearTimeout(debounceTimer)
    debounceTimer = null
  }

  const closeWatchers = (): void => {
    for (const watcher of watchers) {
      try {
        watcher.close()
      } catch {
        // 单个关闭失败不阻断其余清理
      }
    }
    watchers = []
  }

  /** 防抖到期：窗口存活才发 dirty 事件（renderer 据此递增 revision）。 */
  const flushDirty = (): void => {
    debounceTimer = null
    if (!options.getWindow()) return
    options.emit({ method: GIT_PANEL_IPC_CHANNELS.dirty, params: {} })
  }

  const safeWatch = (target: string): void => {
    if (!existsSync(target)) return
    try {
      const watcher = watch(target, { recursive: true }, () => {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(flushDirty, debounceMs)
      })
      watcher.on('error', (error) => {
        warn(`git workspace watcher error: ${target}`, error)
        clearDebounce()
        closeWatchers()
      })
      watchers.push(watcher)
    } catch (error) {
      warn(`git workspace watcher failed to start: ${target}`, error)
    }
  }

  return {
    watchWorkspace(workspacePath: string) {
      clearDebounce()
      closeWatchers()
      safeWatch(workspacePath)
      safeWatch(join(workspacePath, '.git'))
    },
    unwatchAll() {
      clearDebounce()
      closeWatchers()
    },
  }
}

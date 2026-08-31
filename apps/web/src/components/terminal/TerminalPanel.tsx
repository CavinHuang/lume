/**
 * 右侧面板「终端」tab —— xterm.js 真实终端（对齐 ZCode CTt 组件形状）。
 *
 * 对齐 ZCode SidePane terminal tab 的核心语义（docs/analysis/P3-wiki-terminal.md §2）：
 *  - 真实 shell 会话（sidecar node-pty terminal-service），数据流 terminal:data →
 *    xterm.write；退出流 terminal:exit → 终端内暗色提示 + 会话标记 exited
 *    （ZCode per-id onDynamicExit）；
 *  - 键级输入（terminal.onData → terminal:write，含控制字符，交互式程序可用）；
 *  - FitAddon 尺寸协商：ResizeObserver → fit() → onResize → pty.resize
 *    （ZCode FitAddon 去抖思路）；
 *  - 会话与 tab 生命周期解耦：切换 tab 不杀 PTY；模块级会话仓持续累积缓冲，
 *    重挂载时回放（ZCode stash 注册表的 Lume 落法 = xterm 实例随挂载建毁，
 *    持久面是缓冲而非实例）；
 *  - 关闭语义差异：tab 关闭/应用内不回收 PTY，仅 LRU（MAX_SESSIONS）淘汰与
 *    renderer 卸载（pagehide）时全量 dispose。
 *
 * 与 ZCode 的偏差：不接 settingService 终端字体/主题 profile（Lume 尚无该设置面），
 * 以面板 CSS 变量取底色/前景色适配应用主题。
 */
import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { SquareTerminal } from 'lucide-react'
import { useEffect, useReducer, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  createTerminalSession,
  disposeTerminal,
  onTerminalData,
  onTerminalExit,
  resizeTerminal,
  writeTerminal,
} from '@/lib/desktop-api/terminal'

/* ── 模块级会话仓（跨 tab 切换保活；ZCode stash 的简化落法） ─────────────── */

interface TerminalSessionState {
  id: string
  shell: string | null
  /** 跨挂载持久面：xterm 实例随挂载建毁，重挂载时回放。 */
  buffer: string
  status: 'ready' | 'error' | 'exited'
  error?: string
  exitCode?: number | null
}

/** 会话上限（LRU）：防止长期使用期间 shell 无界累积。 */
const MAX_SESSIONS = 4
/** 回放缓冲上限（字符）：超限掐头（对齐行边界），控制重放规模。 */
const TERMINAL_BUFFER_LIMIT = 200_000

const sessions = new Map<string, TerminalSessionState>()
const pendingCreates = new Map<string, Promise<void>>()
const storeListeners = new Set<() => void>()
/** 当前挂载中的 xterm 实例（pump 直写通道；同一会话至多一个挂载面板）。 */
const activeTerminals = new Map<string, Terminal>()
let unsubscribePump: (() => void) | null = null
let unsubscribeExitPump: (() => void) | null = null
let pagehideBound = false

const MONOSPACE_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

function notifyStoreListeners(): void {
  for (const listener of [...storeListeners]) listener()
}

function appendCapped(buffer: string, data: string): string {
  const merged = buffer + data
  if (merged.length <= TERMINAL_BUFFER_LIMIT) return merged
  const keep = TERMINAL_BUFFER_LIMIT - 20_000
  const cutAt = merged.indexOf('\n', merged.length - keep)
  const head = cutAt >= 0 ? merged.slice(cutAt + 1) : merged.slice(-keep)
  return '…（早期输出已截断）\n' + head
}

function evictOldestSession(): void {
  const oldestKey = sessions.keys().next().value
  if (oldestKey === undefined) return
  const oldest = sessions.get(oldestKey)
  sessions.delete(oldestKey)
  if (oldest?.id) void disposeTerminal({ id: oldest.id }).catch(() => undefined)
}

function formatExitNotice(exitCode: number | null): string {
  return `\r\n\x1b[2m[进程已退出 code=${exitCode ?? 'unknown'}]\x1b[0m\r\n`
}

/**
 * 数据泵：全局单订阅（data/exit 各一），按会话 id 分发。tab 未挂载期间输出照常
 * 累积进缓冲；已挂载的 xterm 实例同步直写。注册/回放在挂载 effect 内同步完成，
 * 事件（IPC 宏任务）不会插入其间，无重复/乱序窗口。
 */
function ensureDataPump(): void {
  if (unsubscribePump && unsubscribeExitPump) return
  unsubscribePump ??= onTerminalData((event) => {
    for (const [key, session] of sessions) {
      if (session.id !== event.id) continue
      session.buffer = appendCapped(session.buffer, event.data)
      activeTerminals.get(key)?.write(event.data)
      notifyStoreListeners()
      return
    }
  })
  unsubscribeExitPump ??= onTerminalExit((event) => {
    for (const [key, session] of sessions) {
      if (session.id !== event.id) continue
      session.status = 'exited'
      session.exitCode = event.exitCode
      activeTerminals.get(key)?.write(formatExitNotice(event.exitCode))
      notifyStoreListeners()
      return
    }
  })
  if (!pagehideBound && typeof window !== 'undefined') {
    pagehideBound = true
    // renderer 卸载（关窗/刷新）时回收全部 shell，避免 sidecar 侧进程泄漏。
    window.addEventListener('pagehide', disposeAllSessions)
  }
}

function disposeAllSessions(): void {
  for (const session of sessions.values()) {
    if (session.id) void disposeTerminal({ id: session.id }).catch(() => undefined)
  }
  sessions.clear()
}

function ensureSession(sessionKey: string, cwd?: string): void {
  if (sessions.has(sessionKey) || pendingCreates.has(sessionKey)) return
  const creating = createTerminalSession({ cwd: cwd ?? null, cols: 80, rows: 24 })
    .then((result) => {
      pendingCreates.delete(sessionKey)
      if (sessions.size >= MAX_SESSIONS) evictOldestSession()
      sessions.delete(sessionKey)
      sessions.set(sessionKey, { id: result.id, shell: result.shell, buffer: '', status: 'ready' })
      notifyStoreListeners()
    })
    .catch((error) => {
      pendingCreates.delete(sessionKey)
      sessions.set(sessionKey, {
        id: '',
        shell: null,
        buffer: '',
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      notifyStoreListeners()
    })
  pendingCreates.set(sessionKey, creating)
}

function retrySession(sessionKey: string, cwd?: string): void {
  sessions.delete(sessionKey)
  notifyStoreListeners()
  ensureSession(sessionKey, cwd)
}

/** 重挂载时刷新 LRU 最近使用序（Map 插入序即淘汰序）。 */
function touchSession(sessionKey: string): void {
  const session = sessions.get(sessionKey)
  if (!session) return
  sessions.delete(sessionKey)
  sessions.set(sessionKey, session)
}

/* ── 组件 ─────────────────────────────────────────────────────────────── */

interface TerminalPanelProps {
  /** 当前会话绑定的项目目录；缺失时 sidecar 回落用户主目录。 */
  workspacePath?: string
}

export function TerminalPanel({ workspacePath }: TerminalPanelProps) {
  const sessionKey = workspacePath ?? ''
  const [, forceRender] = useReducer((count: number) => count + 1, 0)
  const termRef = useRef<HTMLDivElement | null>(null)

  // 挂载即确保会话 + 订阅数据泵 + 建 xterm 实例（注册与缓冲回放同任务同步完成）。
  useEffect(() => {
    ensureDataPump()
    touchSession(sessionKey)
    ensureSession(sessionKey, workspacePath)
    storeListeners.add(forceRender)
    const container = termRef.current
    if (!container) return

    const style = window.getComputedStyle(container)
    const terminal = new Terminal({
      fontSize: 12,
      fontFamily: MONOSPACE_FAMILY,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: style.backgroundColor,
        foreground: style.color,
        cursor: style.color,
        selectionBackground: '#64748b66',
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    activeTerminals.set(sessionKey, terminal)
    const session = sessions.get(sessionKey)
    if (session?.buffer) terminal.write(session.buffer)
    if (session?.status === 'exited') terminal.write(formatExitNotice(session.exitCode ?? null))

    const dataSubscription = terminal.onData((data) => {
      const current = sessions.get(sessionKey)
      if (!current?.id || current.status !== 'ready') return
      void writeTerminal({ id: current.id, data }).catch(() => undefined)
    })
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      const current = sessions.get(sessionKey)
      if (!current?.id || current.status !== 'ready') return
      void resizeTerminal({ id: current.id, cols, rows }).catch(() => undefined)
    })
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // 容器尺寸瞬时不可测（display:none 等）时跳过本轮
      }
    })
    observer.observe(container)
    try {
      fit.fit()
    } catch {
      // 同上
    }

    return () => {
      observer.disconnect()
      dataSubscription.dispose()
      resizeSubscription.dispose()
      activeTerminals.delete(sessionKey)
      terminal.dispose()
    }
  }, [sessionKey, workspacePath])

  const session = sessions.get(sessionKey)

  if (!session) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-[var(--lume-text-muted)]">
        <Spinner />
      </div>
    )
  }

  if (session.status === 'error') {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <SquareTerminal size={20} className="text-[var(--lume-text-muted)]" />
        <div className="text-sm font-medium text-[var(--lume-text-secondary)]">无法创建终端会话</div>
        <div className="text-xs text-[var(--lume-text-muted)]">{session.error}</div>
        <Button variant="outline" size="sm" type="button" onClick={() => retrySession(sessionKey, workspacePath)}>
          重试
        </Button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={termRef} className="min-h-0 flex-1 bg-[var(--lume-bg-panel)] px-2 py-1" />
    </div>
  )
}

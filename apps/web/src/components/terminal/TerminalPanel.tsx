/**
 * 右侧面板「终端」tab —— 简易终端（MVP 非 xterm：输出 <pre> + 单行输入）。
 *
 * 对齐 ZCode SidePane terminal tab 的核心语义（docs/analysis/P3-wiki-terminal.md §2）：
 *  - 真实 shell 会话（sidecar terminal-service），数据流 terminal:data → 追加缓冲；
 *  - 会话与 tab 生命周期解耦：切换 tab 不杀 PTY（ZCode stash 注册表的 Lume 落法 =
 *    模块级会话仓，缓冲在 renderer 侧持续累积，重挂载即恢复画面）；
 *  - 关闭语义差异：tab 关闭/应用内不回收 PTY，仅 LRU（MAX_SESSIONS）淘汰与
 *    renderer 卸载（pagehide）时全量 dispose —— 显式按 tab 回收待 reducer 支持
 *    tab 关闭回调后跟进。
 *
 * 渲染限制（xterm 升级路径）：无逐字符网格/光标/滚动区，\r 覆写与 TUI 全屏程序
 * （vim/htop）不可用；单行输入模式（Enter 提交）。颜色为固定调色板近似。
 */
import { SquareTerminal, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type FormEvent, type RefObject } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import {
  createTerminalSession,
  disposeTerminal,
  onTerminalData,
  resizeTerminal,
  writeTerminal,
} from '@/lib/desktop-api/terminal'
import { ANSI_COLOR_CLASSES } from './terminal-ansi-types'
import { parseAnsiSegments, splitAnsiLines, type AnsiSegment } from './terminal-ansi'

/* ── 模块级会话仓（跨 tab 切换保活；ZCode stash 的简化落法） ─────────────── */

interface TerminalSessionState {
  id: string
  shell: string | null
  buffer: string
  status: 'ready' | 'error'
  error?: string
}

/** 会话上限（LRU）：防止长期使用期间 shell 无界累积。 */
const MAX_SESSIONS = 4
/** 输出缓冲上限（字符）：超限掐头（对齐行边界），控制重解析/DOM 规模。 */
const TERMINAL_BUFFER_LIMIT = 200_000
/** resize 上报防抖（ms），对齐 ZCode FitAddon 去抖思路。 */
const RESIZE_DEBOUNCE_MS = 200

const sessions = new Map<string, TerminalSessionState>()
const pendingCreates = new Map<string, Promise<void>>()
const storeListeners = new Set<() => void>()
let unsubscribePump: (() => void) | null = null
let pagehideBound = false

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

/** 数据泵：全局单订阅，按会话 id 分发（tab 未挂载期间输出照常累积）。 */
function ensureDataPump(): void {
  if (unsubscribePump) return
  unsubscribePump = onTerminalData((event) => {
    for (const session of sessions.values()) {
      if (session.id !== event.id) continue
      session.buffer = appendCapped(session.buffer, event.data)
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
  const [inputValue, setInputValue] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLSpanElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const stickToBottomRef = useRef(true)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 挂载即确保会话 + 订阅数据泵（会话不随 tab 切换销毁；仅重渲染订阅随挂载增减）。
  useEffect(() => {
    ensureDataPump()
    touchSession(sessionKey)
    ensureSession(sessionKey, workspacePath)
    storeListeners.add(forceRender)
    return () => { storeListeners.delete(forceRender) }
  }, [sessionKey, workspacePath])

  const session = sessions.get(sessionKey)

  const lines = useMemo<Array<AnsiSegment[]>>(
    () => (session ? splitAnsiLines(parseAnsiSegments(session.buffer)) : []),
    [session?.buffer],
  )

  // 输出追加后贴底滚动（用户上翻时让位）。
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller || !stickToBottomRef.current) return
    scroller.scrollTop = scroller.scrollHeight
  }, [lines])

  // 尺寸上报：ResizeObserver → 估算 cols/rows → 防抖上报（MVP 仅 sidecar 记录）。
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const report = () => {
      const current = sessions.get(sessionKey)
      if (!current?.id) return
      const measure = measureRef.current
      if (!measure) return
      const charWidth = measure.getBoundingClientRect().width / 10
      if (!Number.isFinite(charWidth) || charWidth <= 0) return
      const cols = Math.max(20, Math.floor(container.clientWidth / charWidth) - 1)
      const rows = Math.max(6, Math.floor(container.clientHeight / 16))
      void resizeTerminal({ id: current.id, cols, rows }).catch(() => undefined)
    }
    const debounced = () => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(report, RESIZE_DEBOUNCE_MS)
    }
    const observer = new ResizeObserver(debounced)
    observer.observe(container)
    return () => {
      observer.disconnect()
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = null
    }
  }, [sessionKey])

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!session?.id || !inputValue) return
    setInputValue('')
    void writeTerminal({ id: session.id, data: `${inputValue}\n` }).catch(() => undefined)
  }

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
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--lume-bg-panel)]">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-1"
        onScroll={(event) => {
          const el = event.currentTarget
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
        onMouseUp={() => {
          // 点击输出区回到输入行（有选区时让位复制）。
          if (!window.getSelection()?.toString()) inputRef.current?.focus()
        }}
      >
        <pre className="w-full font-mono text-[11px] leading-4 break-words whitespace-pre-wrap">
          {lines.map((segments, lineIndex) => (
            <div key={lineIndex}>{segments.length === 0 ? ' ' : segments.map((segment, segmentIndex) => (
              <span
                key={segmentIndex}
                className={cn(
                  segment.color ? ANSI_COLOR_CLASSES[segment.color] : 'text-[var(--lume-text-secondary)]',
                  segment.bold && 'font-semibold',
                )}
              >
                {segment.text}
              </span>
            ))}</div>
          ))}
        </pre>
      </div>
      <form onSubmit={handleSubmit} className="flex h-9 shrink-0 items-center gap-1.5 border-t border-[var(--lume-border-subtle)] px-2">
        <SquareTerminal size={13} className="shrink-0 text-[var(--lume-text-muted)]" />
        <Input
          ref={inputRef as RefObject<HTMLInputElement>}
          value={inputValue}
          onChange={(event) => setInputValue(event.target.value)}
          className="h-7 rounded-md border-none bg-transparent px-1 font-mono text-xs"
          placeholder={session.shell ? `${shellLabel(session.shell)} — 输入命令后回车` : '输入命令后回车'}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        {inputValue && (
          <Button variant="ghost" size="icon-xs" type="button" title="清空输入" onClick={() => setInputValue('')}>
            <X size={12} />
          </Button>
        )}
      </form>
      <span
        ref={measureRef}
        aria-hidden
        className="pointer-events-none absolute -top-40 font-mono text-[11px] opacity-0"
      >
        0000000000
      </span>
    </div>
  )
}

function shellLabel(shell: string): string {
  const name = shell.split(/[\\/]/).at(-1) ?? shell
  return name.replace(/\.exe$/i, '')
}

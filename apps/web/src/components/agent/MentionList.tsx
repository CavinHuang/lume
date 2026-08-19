import { Fragment, forwardRef, useEffect, useImperativeHandle, useRef, useState, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { Bot, File, Globe2, Hash, TerminalSquare, ArrowLeft, Loader2, Package, BookOpen, ListChecks } from 'lucide-react'
import { type MentionItem } from './slash-command-state'
import { getMcpConfig, getMcpStatus } from '@/lib/desktop-api'
import { buildMcpServerRows, type McpServerRow, type McpUiStatus } from '@/components/settings/mcp-settings-state'

import { Button } from '@/components/ui/button'
import { ProviderIcon } from '@/components/link/ProviderIcon'
interface MentionListProps {
  items: MentionItem[]
  command: (item: MentionItem & { occurrenceId?: string }) => void
  trigger?: '@' | '/' | '#' | '&'
  getWorkspaceSlug?: () => string | null
  /** 选中即执行命令（executeOnSelect）时触发，替代插入 mention 文本 */
  onCommandExecute?: (id: string) => void
  onBrowserReferenceSelect?: (item: MentionItem) => void
  onLinkConnectionReferenceSelect?: (item: MentionItem) => void
}

export interface MentionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean
}

export const MentionList = forwardRef<MentionListRef, MentionListProps>(
  function MentionList({ items, command, trigger = '/', getWorkspaceSlug, onCommandExecute, onBrowserReferenceSelect, onLinkConnectionReferenceSelect }, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0)
    const [panelMode, setPanelMode] = useState<'commands' | 'mcp-status'>('commands')
    const [mcpRows, setMcpRows] = useState<McpServerRow[]>([])
    const [mcpLoading, setMcpLoading] = useState(false)
    const [mcpSelectedIndex, setMcpSelectedIndex] = useState(0)
    const [engaged, setEngaged] = useState(false)
    const [rowBox, setRowBox] = useState<{ top: number; height: number } | null>(null)
    const listRef = useRef<HTMLDivElement | null>(null)
    const rowRefs = useRef<(HTMLButtonElement | null)[]>([])
    const displayItems = items

    useEffect(() => {
      setSelectedIndex(0)
      setEngaged(false)
    }, [items])

    useEffect(() => {
      const target = rowRefs.current[selectedIndex]
      if (!target) return

      const top = target.offsetTop
      const height = target.offsetHeight
      setRowBox({ top, height })

      const list = listRef.current
      if (!engaged || !list) return

      const viewTop = list.scrollTop
      const viewBottom = viewTop + list.clientHeight
      const bottom = top + height
      let nextScrollTop: number | null = null
      if (top < viewTop) nextScrollTop = Math.max(0, top - 4)
      if (bottom > viewBottom) nextScrollTop = bottom - list.clientHeight + 4
      if (nextScrollTop === null) return

      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      list.scrollTo({ top: nextScrollTop, behavior: reduceMotion ? 'auto' : 'smooth' })
    }, [displayItems.length, engaged, selectedIndex])

    const fetchMcpData = useCallback(async () => {
      const slug = getWorkspaceSlug?.()
      if (!slug) return
      setMcpLoading(true)
      try {
        const [statusResult, configResult] = await Promise.all([
          getMcpStatus(slug, { waitForConnections: false }),
          getMcpConfig(slug),
        ])
        const rows = buildMcpServerRows(configResult?.servers, statusResult?.servers)
        setMcpRows(rows)
      } catch {
        setMcpRows([])
      } finally {
        setMcpLoading(false)
      }
    }, [getWorkspaceSlug])

    const selectItem = useCallback((index: number) => {
      const item = displayItems[index]
      if (!item) return
      if (item.disabled) return
      if (item.type === 'browser' && item.browserCandidate && onBrowserReferenceSelect) {
        onBrowserReferenceSelect(item)
        return
      }
      if (item.type === 'connector' && onLinkConnectionReferenceSelect) {
        onLinkConnectionReferenceSelect(item)
        return
      }
      if (item.id === 'mcp' && item.type === 'command') {
        setPanelMode('mcp-status')
        setMcpSelectedIndex(0)
        fetchMcpData()
        return
      }
      if (item.executeOnSelect && onCommandExecute) {
        onCommandExecute(item.id)
        return
      }
      command({
        ...item,
        ...(item.uri ? { occurrenceId: crypto.randomUUID() } : {}),
      })
    }, [displayItems, command, fetchMcpData, onBrowserReferenceSelect, onCommandExecute, onLinkConnectionReferenceSelect])

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        if (panelMode === 'mcp-status') {
          if (event.key === 'Escape') {
            return false
          }
          if (event.key === 'Backspace') {
            setPanelMode('commands')
            return true
          }
          if (mcpRows.length > 0) {
            if (event.key === 'ArrowUp') {
              setMcpSelectedIndex((i) => (i + mcpRows.length - 1) % mcpRows.length)
              return true
            }
            if (event.key === 'ArrowDown') {
              setMcpSelectedIndex((i) => (i + 1) % mcpRows.length)
              return true
            }
          }
          return false
        }

        if (displayItems.length === 0) return false
        if (event.key === 'ArrowUp') {
          setEngaged(true)
          setSelectedIndex((i) => (i + displayItems.length - 1) % displayItems.length)
          return true
        }
        if (event.key === 'ArrowDown') {
          setEngaged(true)
          setSelectedIndex((i) => (i + 1) % displayItems.length)
          return true
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          selectItem(selectedIndex)
          return true
        }
        return false
      },
    }))

    // MCP 状态面板：优先于空状态检查，确保面板切换时宽度不变
    if (panelMode === 'mcp-status') {
      return (
        <div className="lume-suggestion-panel w-full overflow-hidden rounded-[10px] bg-[var(--surface-1)] p-1 shadow-[0_14px_36px_-16px_hsl(var(--shadow-panel)/0.58)]">
          <Button
            variant="ghost"
            className="flex h-9 w-full items-center justify-start gap-2.5 rounded-[6px] px-2 text-left text-[12.5px] font-medium text-[var(--text-1)] hover:bg-[var(--surface-3)]"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setPanelMode('commands')}
          >
            <span className="flex size-[22px] shrink-0 items-center justify-center text-[var(--text-2)]">
              <ArrowLeft size={14} />
            </span>
            MCP 服务状态
          </Button>

          {mcpLoading ? (
            <div className="flex h-9 items-center justify-center">
              <Loader2 size={16} className="animate-spin text-[var(--text-3)]" />
            </div>
          ) : mcpRows.length === 0 ? (
            <div className="flex h-9 items-center px-2 text-[12px] text-[var(--text-3)]">暂无 MCP 服务配置</div>
          ) : (
            <div className="mention-list-scrollbar max-h-[280px] overflow-y-auto">
              {mcpRows.map((row, index) => (
                <div
                  key={row.name}
                  className={cn(
                    'flex h-9 items-center gap-2.5 rounded-[6px] px-2 transition-colors duration-100',
                    index === mcpSelectedIndex
                      ? 'bg-[var(--surface-3)]'
                      : 'hover:bg-[var(--surface-3)]'
                  )}
                  onMouseEnter={() => setMcpSelectedIndex(index)}
                >
                  <span className="flex size-[22px] shrink-0 items-center justify-center">
                    <span className={cn('size-2 rounded-full', getMcpStatusDotClass(row.status))} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--text-1)]">
                    {row.displayName}
                  </span>
                  <span className="shrink-0 text-[12px] text-[var(--text-3)]">
                    {row.toolCount > 0 ? `${row.toolCount} 个工具` : '无工具'}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="mt-1 border-t border-[var(--border)] px-2 pb-1 pt-1.5 text-[11px] text-[var(--text-3)]">Backspace 返回命令列表</div>
        </div>
      )
    }

    if (displayItems.length === 0) {
      const emptyLabel = trigger === '@'
        ? '继续输入关键词搜索 Agent、连接账户或文件'
        : trigger === '#'
          ? '继续输入关键词搜索 MCP 服务'
          : trigger === '&'
            ? '继续输入关键词搜索 Planning Todo'
          : '继续输入关键词搜索动作、技能或插件'
      return (
        <div className="lume-suggestion-panel w-full overflow-hidden rounded-[10px] bg-[var(--surface-1)] p-1 shadow-[0_14px_36px_-16px_hsl(var(--shadow-panel)/0.58)]">
          <div className="flex h-9 items-center px-2 text-[12px] text-[var(--text-3)]">没有匹配项</div>
          <div className="mt-1 border-t border-[var(--border)] px-2 pb-1 pt-1.5 text-[11px] text-[var(--text-3)]">{emptyLabel}</div>
        </div>
      )
    }

    const footerLabel = trigger === '@'
      ? '继续输入以搜索 Agent、连接账户、网页与文件'
      : trigger === '/'
        ? '继续输入以搜索命令、技能与插件'
        : trigger === '#'
          ? '继续输入以搜索 MCP 服务'
          : '继续输入以搜索 Planning Todo'

    return (
      <div
        className="lume-suggestion-panel w-full overflow-hidden rounded-[10px] bg-[var(--surface-1)] p-1 shadow-[0_14px_36px_-16px_hsl(var(--shadow-panel)/0.58)]"
        onMouseLeave={() => setEngaged(false)}
      >
        <div ref={listRef} className="mention-list-scrollbar relative max-h-[min(360px,calc(100vh-160px))] overflow-y-auto" role="listbox">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 rounded-[6px] bg-[var(--lume-accent-soft)]"
            style={{
              top: rowBox?.top ?? 0,
              height: rowBox?.height ?? 0,
              opacity: rowBox && engaged ? 1 : 0,
              transition: 'top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease',
            }}
          />
          {displayItems.map((item, index) => {
            const showSectionHeader = item.section && item.section !== displayItems[index - 1]?.section
            return (
              <Fragment key={`${item.type}:${item.id}`}>
                {showSectionHeader ? (
                  <div className={cn('relative z-10 px-2 pb-1 text-[10px] font-medium text-[var(--text-3)]', index === 0 ? 'pt-1.5' : 'pt-2')}>
                    {getMentionSectionLabel(item.section)}
                  </div>
                ) : null}
                <Button
                  ref={(element) => { rowRefs.current[index] = element }}
                  variant="ghost"
                  role="option"
                  aria-selected={index === selectedIndex}
                  disabled={item.disabled}
                  title={item.disabledReason}
                  className="relative z-10 flex h-9 w-full items-center justify-start gap-2.5 rounded-[6px] px-2 text-left hover:bg-transparent dark:hover:bg-transparent disabled:opacity-50"
                  onClick={() => selectItem(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => {
                    setSelectedIndex(index)
                    setEngaged(true)
                  }}
                >
                  {trigger !== '/' ? (
                    <span className="flex size-[22px] shrink-0 items-center justify-center text-[var(--text-2)]">
                      <MentionItemIcon item={item} />
                    </span>
                  ) : null}
                  <span className="max-w-[45%] shrink-0 truncate text-[12.5px] font-medium text-[var(--text-1)]">
                    {item.title ?? item.label}
                  </span>
                  {item.subtitle ? (
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-3)]">{item.subtitle}</span>
                  ) : (
                    <span className="min-w-0 flex-1" />
                  )}
                  {item.meta ? (
                    <span className="max-w-28 shrink-0 truncate text-[11px] text-[var(--text-3)]">
                      {item.meta}
                    </span>
                  ) : null}
                </Button>
              </Fragment>
            )
          })}
        </div>

        <div className="mt-1 border-t border-[var(--border)] px-2 pb-1 pt-1.5 text-[11px] text-[var(--text-3)]">{footerLabel}</div>
      </div>
    )
  }
)

function getMentionSectionLabel(section: MentionItem['section']): string {
  if (section === 'capability') return '动作'
  if (section === 'agent') return 'Agents'
  if (section === 'connector') return '已连接账户'
  if (section === 'browser-tab') return '内置浏览器'
  if (section === 'chrome-page') return 'Chrome 最近标签'
  if (section === 'project-file') return '项目文件'
  if (section === 'session-file') return '会话文件'
  if (section === 'file') return 'Files'
  if (section === 'plugin') return '插件'
  if (section === 'todo') return 'Planning Todo'
  return '技能'
}

function MentionItemIcon({ item }: { item: MentionItem }) {
  const [failed, setFailed] = useState(false)
  if (item.type === 'connector' && item.service) {
    return <ProviderIcon service={item.service} displayName={item.title} iconUrl={item.iconUrl} size={18} />
  }
  if (item.iconUrl && !failed) {
    return <img src={item.iconUrl} alt="" className="size-4 rounded object-contain" onError={() => setFailed(true)} />
  }
  if (item.type === 'plugin') return <Package size={16} />
  if (item.type === 'skill') return <BookOpen size={16} />
  if (item.type === 'agent') return <Bot size={16} />
  if (item.type === 'browser') return <Globe2 size={16} />
  if (item.type === 'file') return <File size={16} />
  if (item.type === 'mcp') return <Hash size={16} />
  if (item.type === 'todo') return <ListChecks size={16} />
  return <TerminalSquare size={16} />
}

function getMcpStatusDotClass(status: McpUiStatus): string {
  switch (status) {
    case 'connected':
      return 'bg-[#20c872]'
    case 'connecting':
      return 'bg-[#4f7df3] animate-pulse'
    case 'warning':
      return 'bg-[#ff9d2e]'
    case 'disconnected':
      return 'bg-[#a3aabc]'
    default:
      return 'bg-[#a3aabc]'
  }
}

import { forwardRef, useEffect, useImperativeHandle, useState, useCallback, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Blocks, Bot, File, Globe2, Hash, TerminalSquare, ArrowLeft, Loader2, Package, BookOpen, ListChecks } from 'lucide-react'
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
    const displayItems = items

    useEffect(() => setSelectedIndex(0), [items])

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
          setSelectedIndex((i) => (i + displayItems.length - 1) % displayItems.length)
          return true
        }
        if (event.key === 'ArrowDown') {
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
        <div className="w-full overflow-hidden rounded-[1.4rem] border border-[color:color-mix(in_oklab,var(--border-strong)_52%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_98%,transparent)] shadow-[0_18px_46px_-34px_hsl(var(--shadow-panel)/0.42)]">
          {/* 标题栏 */}
          <div className="flex items-center gap-2 border-b border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] px-3 py-2.5">
            <Button
                variant="ghost"
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-3)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_52%,transparent)] hover:text-[var(--text-2)]"
              onClick={() => setPanelMode('commands')}
            >
              <ArrowLeft size={14} />
            </Button>
            <span className="text-[12px] font-medium text-[var(--text-1)]">MCP 服务状态</span>
          </div>

          {/* 内容区 */}
          {mcpLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={16} className="animate-spin text-[var(--text-3)]" />
            </div>
          ) : mcpRows.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-[var(--text-3)]">
              暂无 MCP 服务配置
            </div>
          ) : (
            <div className="mention-list-scrollbar max-h-[280px] overflow-y-auto p-2">
              {mcpRows.map((row, index) => (
                <div
                  key={row.name}
                  className={cn(
                    'flex items-center gap-2.5 rounded-[0.75rem] px-2.5 py-2 transition-colors',
                    index === mcpSelectedIndex
                      ? 'bg-[color:color-mix(in_oklab,var(--surface-3)_72%,transparent)]'
                      : 'hover:bg-[color:color-mix(in_oklab,var(--surface-3)_42%,transparent)]'
                  )}
                  onMouseEnter={() => setMcpSelectedIndex(index)}
                >
                  <span className={cn('size-2 shrink-0 rounded-full', getMcpStatusDotClass(row.status))} />
                  <span className="truncate text-[12px] font-medium text-[var(--text-1)]">
                    {row.displayName}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-[var(--text-3)]">
                    {row.toolCount > 0 ? `${row.toolCount} 个工具` : '无工具'}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* 底栏提示 */}
          <div className="flex items-center justify-between border-t border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] px-3 py-1.5 text-[10px] text-[var(--text-3)]">
            <span>← 返回命令列表</span>
            <span>Esc 关闭</span>
          </div>
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
        <div className="min-w-[280px] rounded-[1.25rem] border border-[color:color-mix(in_oklab,var(--border-strong)_58%,transparent)] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--surface-1)_98%,transparent),color-mix(in_oklab,var(--surface-2)_94%,transparent))] p-3 shadow-[0_22px_52px_-32px_hsl(var(--shadow-panel)/0.45)]">
          <p className="text-[12px] font-medium text-[var(--text-2)]">没有匹配项</p>
          <p className="mt-1 text-[11px] text-[var(--text-3)]">{emptyLabel}</p>
        </div>
      )
    }

    if (trigger === '/') {
      let previousSection: MentionItem['section'] | undefined

      return (
        <div className="w-full overflow-hidden rounded-[1.4rem] border border-[color:color-mix(in_oklab,var(--border-strong)_52%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_98%,transparent)] shadow-[0_18px_46px_-34px_hsl(var(--shadow-panel)/0.42)]">
          <div className="mention-list-scrollbar flex max-h-[420px] flex-col gap-0.5 overflow-y-auto p-2">
            {displayItems.map((item, index) => {
              const showSectionHeader = item.section && item.section !== previousSection
              previousSection = item.section

              return (
                <div key={`${item.type}:${item.id}`}>
                  {showSectionHeader ? (
                    <div className="px-0.5 py-1 text-[12px] font-medium text-[var(--text-3)]">
                      {getMentionSectionLabel(item.section)}
                    </div>
                  ) : null}
                  <Button
                variant="ghost"
                    disabled={item.disabled}
                    title={item.disabledReason}
                    className={cn(
                      'grid min-h-8 w-full grid-cols-[24px_minmax(0,auto)_minmax(0,1fr)_auto] items-center gap-2 rounded-[0.75rem] py-1 pl-0.5 pr-1 text-left transition-colors',
                      index === selectedIndex
                        ? 'bg-[color:color-mix(in_oklab,var(--surface-3)_72%,transparent)]'
                        : 'hover:bg-[color:color-mix(in_oklab,var(--surface-3)_42%,transparent)]'
                    )}
                    onClick={() => selectItem(index)}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <span className="flex h-6 w-6 items-center justify-center text-[var(--text-2)]">
                      <MentionItemIcon item={item} />
                    </span>
                    <span className="truncate text-[12px] font-medium leading-none text-[var(--text-1)]">
                      {item.title ?? item.label}
                    </span>
                    {item.subtitle ? (
                      <span className="truncate text-[12px] leading-none text-[var(--text-3)]">
                        {item.subtitle}
                      </span>
                    ) : (
                      <span />
                    )}
                    {item.meta ? (
                      <span className="pl-2 text-[12px] leading-none text-[var(--text-3)]">
                        {item.meta}
                      </span>
                    ) : null}
                  </Button>
                </div>
              )
            })}
          </div>
        </div>
      )
    }

    const panelTitle = trigger === '@' ? 'Agents & Context' : trigger === '#' ? 'MCP Servers' : trigger === '&' ? 'Planning Todo' : 'Slash Commands'
    const panelDescription = trigger === '@'
      ? '选择 Agent、已连接账户，或引用网页与文件'
      : trigger === '#'
        ? '选择可用的 MCP 服务与工具入口'
        : trigger === '&'
          ? '当前项目未完成待办优先，也可搜索全部待办'
        : '动作、技能和插件都可以在这里选择'
    let previousSection: MentionItem['section'] | undefined

    return (
      <div className="min-w-[320px] max-w-[380px] overflow-hidden rounded-[14px] border border-[color:color-mix(in_oklab,var(--border-strong)_62%,transparent)] bg-[var(--surface-1)] shadow-[0_24px_60px_-30px_hsl(var(--shadow-panel)/0.62)]">
        <div className="flex items-start gap-3 border-b border-[color:color-mix(in_oklab,var(--border-strong)_46%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-2)_46%,transparent)] px-3.5 py-3">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-[color:color-mix(in_oklab,var(--brand)_24%,var(--border-strong))] bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]">
            <Blocks size={14} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-[13px] font-semibold tracking-[-0.01em] text-[var(--text-1)]">
                {panelTitle}
              </h3>
              <span className="rounded-md border border-[color:color-mix(in_oklab,var(--border-strong)_54%,transparent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-3)]">
                {trigger}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11px] leading-4 text-[var(--text-3)]">{panelDescription}</p>
          </div>
        </div>

        <div className="mention-list-scrollbar max-h-[min(380px,calc(100vh-160px))] overflow-y-auto px-2 py-2">
          {displayItems.map((item, index) => {
            const showSectionHeader = item.section && item.section !== previousSection
            previousSection = item.section

            return (
              <div key={`${item.type}:${item.id}`} className="mb-0.5 last:mb-0">
                {showSectionHeader ? (
                  <div className="flex items-center gap-2 px-2 pb-1.5 pt-2.5 first:pt-1">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-3)]">
                      {getMentionSectionLabel(item.section)}
                    </span>
                    <span className="h-px flex-1 bg-[color:color-mix(in_oklab,var(--border-strong)_32%,transparent)]" />
                  </div>
                ) : null}
                <Button
                  variant="ghost"
                  disabled={item.disabled}
                  title={item.disabledReason}
                  className={cn(
                    'group relative h-auto w-full justify-start rounded-[10px] border px-2.5 py-2 text-left transition-colors',
                    index === selectedIndex
                      ? 'border-[color:color-mix(in_oklab,var(--brand)_34%,var(--border-strong))] bg-[color:color-mix(in_oklab,var(--brand)_9%,var(--surface-2))]'
                      : 'border-transparent text-foreground/80 hover:border-[color:color-mix(in_oklab,var(--border-strong)_48%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-3)_58%,transparent)]'
                  )}
                  onClick={() => selectItem(index)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <div className="flex items-start gap-3">
                    <div className={cn(
                      'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border text-[var(--text-2)] transition-colors',
                      index === selectedIndex
                        ? 'border-[color:color-mix(in_oklab,var(--brand)_24%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_12%,var(--surface-1))] text-[var(--brand)]'
                        : 'border-[color:color-mix(in_oklab,var(--border-strong)_38%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-3)_52%,transparent)]'
                    )}>
                      <MentionItemIcon item={item} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-h-5 items-center gap-2">
                        <span className="truncate text-[12.5px] font-semibold leading-5 text-[var(--text-1)]">
                          {item.title ?? item.label}
                        </span>
                        {item.type === 'command' ? (
                          <span className="shrink-0 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-600">
                            快捷
                          </span>
                        ) : null}
                        {(item.type === 'agent' || item.type === 'browser' || item.type === 'connector') && item.meta ? (
                          <span className="shrink-0 rounded-md border border-[color:color-mix(in_oklab,var(--brand)_20%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--brand)]">
                            {item.meta}
                          </span>
                        ) : null}
                      </div>
                      {item.subtitle ? (
                        <p className="mt-0.5 line-clamp-2 text-[11px] leading-[1.35] text-[var(--text-3)]">
                          {item.subtitle}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </Button>
              </div>
            )
          })}
        </div>

        <div className="flex items-center justify-between border-t border-[color:color-mix(in_oklab,var(--border-strong)_46%,transparent)] px-3.5 py-2 text-[10px] text-[var(--text-3)]">
          <span className="flex items-center gap-1.5"><KeyHint>↑↓</KeyHint>选择</span>
          <span className="flex items-center gap-1.5"><KeyHint>Enter</KeyHint>插入</span>
          <span className="flex items-center gap-1.5"><KeyHint>Esc</KeyHint>关闭</span>
        </div>
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

function KeyHint({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-[color:color-mix(in_oklab,var(--border-strong)_52%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-3)_54%,transparent)] px-1 py-0.5 font-mono text-[9px] leading-none text-[var(--text-2)]">
      {children}
    </kbd>
  )
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

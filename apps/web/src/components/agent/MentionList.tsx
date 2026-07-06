import { forwardRef, useEffect, useImperativeHandle, useState, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { Blocks, Bot, Box, File, Hash, TerminalSquare, ArrowLeft, Loader2, Puzzle } from 'lucide-react'
import { normalizeSlashSuggestionItems, type MentionItem } from './slash-command-state'
import { getMcpConfig, getMcpStatus } from '@/lib/desktop-api'
import { buildMcpServerRows, type McpServerRow, type McpUiStatus } from '@/components/settings/mcp-settings-state'

import { Button } from '@/components/ui/button'
interface MentionListProps {
  items: MentionItem[]
  command: (item: { id: string; label: string }) => void
  trigger?: '@' | '/' | '#' | '$' | '%'
  getWorkspaceSlug?: () => string | null
  /** 选中即执行命令（executeOnSelect）时触发，替代插入 mention 文本 */
  onCommandExecute?: (id: string) => void
}

export interface MentionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean
}

export const MentionList = forwardRef<MentionListRef, MentionListProps>(
  function MentionList({ items, command, trigger = '/', getWorkspaceSlug, onCommandExecute }, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0)
    const [panelMode, setPanelMode] = useState<'commands' | 'mcp-status'>('commands')
    const [mcpRows, setMcpRows] = useState<McpServerRow[]>([])
    const [mcpLoading, setMcpLoading] = useState(false)
    const [mcpSelectedIndex, setMcpSelectedIndex] = useState(0)
    const displayItems = trigger === '/' ? normalizeSlashSuggestionItems(items) : items

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
      command({ id: item.id, label: item.label })
    }, [displayItems, command, fetchMcpData, onCommandExecute])

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
        if (event.key === 'Enter') {
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
            <div className="max-h-[280px] overflow-y-auto p-2">
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
        ? '继续输入关键词搜索 Agent 或文件'
        : trigger === '#'
          ? '继续输入关键词搜索 MCP 服务'
          : trigger === '$'
            ? '继续输入关键词搜索技能'
            : '继续输入关键词搜索技能或 slash 能力'
      return (
        <div className="min-w-[280px] rounded-[1.25rem] border border-[color:color-mix(in_oklab,var(--border-strong)_58%,transparent)] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--surface-1)_98%,transparent),color-mix(in_oklab,var(--surface-2)_94%,transparent))] p-3 shadow-[0_22px_52px_-32px_hsl(var(--shadow-panel)/0.45)]">
          <p className="text-[12px] font-medium text-[var(--text-2)]">没有匹配项</p>
          <p className="mt-1 text-[11px] text-[var(--text-3)]">{emptyLabel}</p>
        </div>
      )
    }

    const iconMap = {
      agent: <Bot size={13} className="text-[var(--brand)]" />,
      file: <File size={13} className="text-blue-500" />,
      skill: <Box size={16} className="text-[var(--text-2)]" />,
      mcp: <Hash size={13} className="text-purple-500" />,
      command: <TerminalSquare size={16} className="text-[var(--text-2)]" />,
      plugin: <Puzzle size={13} className="text-[var(--brand)]" />,
    }

    if (trigger === '/' || trigger === '$' || trigger === '%') {
      let previousSection: MentionItem['section'] | undefined

      return (
        <div className="w-full overflow-hidden rounded-[1.4rem] border border-[color:color-mix(in_oklab,var(--border-strong)_52%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_98%,transparent)] shadow-[0_18px_46px_-34px_hsl(var(--shadow-panel)/0.42)]">
          <div className="flex max-h-[420px] flex-col gap-0.5 overflow-y-auto p-2">
            {displayItems.map((item, index) => {
              const showSectionHeader = item.section && item.section !== previousSection
              previousSection = item.section

              return (
                <div key={`${item.type}:${item.id}`}>
                  {showSectionHeader && item.section === 'skill' ? (
                    <div className="px-0.5 py-1 text-[12px] font-medium text-[var(--text-3)]">
                      技能
                    </div>
                  ) : null}
                  <Button
                variant="ghost"
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
                      {iconMap[item.type]}
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
                    {item.section === 'skill' && item.meta ? (
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

    const panelTitle = trigger === '@' ? 'Agents & Files' : trigger === '#' ? 'MCP Servers' : trigger === '$' ? 'Skills' : 'Slash Commands'
    const panelDescription = trigger === '@'
      ? '选择专业 Agent 或引用当前工作区文件'
      : trigger === '#'
        ? '选择可用的 MCP 服务与工具入口'
        : trigger === '$'
          ? '选择工作区技能快速插入'
          : '常用能力和工作区技能都可以在这里快速插入'
    let previousSection: MentionItem['section'] | undefined

    return (
      <div className="min-w-[320px] max-w-[380px] overflow-hidden rounded-[1.35rem] border border-[color:color-mix(in_oklab,var(--border-strong)_58%,transparent)] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--surface-1)_98%,transparent),color-mix(in_oklab,var(--surface-2)_94%,transparent))] shadow-[0_26px_64px_-34px_hsl(var(--shadow-panel)/0.52)]">
        <div className="border-b border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] px-4 py-3">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.24em] text-[var(--text-3)]">
            <Blocks size={12} />
            {panelTitle}
          </div>
          <p className="mt-1 text-[11px] text-[var(--text-3)]">{panelDescription}</p>
        </div>

        <div className="max-h-[320px] overflow-y-auto px-2 py-2">
          {displayItems.map((item, index) => {
            const showSectionHeader = item.section && item.section !== previousSection
            previousSection = item.section

            return (
              <div key={`${item.type}:${item.id}`} className="mb-1 last:mb-0">
                {showSectionHeader ? (
                  <div className="px-2 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-3)]">
                    {getMentionSectionLabel(item.section)}
                  </div>
                ) : null}
                <Button
                variant="ghost"
                  className={cn(
                    'group w-full justify-start rounded-[1rem] border px-3 py-2.5 text-left transition-all',
                    index === selectedIndex
                      ? 'border-[color:color-mix(in_oklab,var(--brand)_28%,var(--border-strong))] bg-[linear-gradient(135deg,color-mix(in_oklab,var(--brand)_9%,var(--surface-2)),color-mix(in_oklab,var(--surface-1)_96%,transparent))] shadow-[0_18px_36px_-32px_color-mix(in_oklab,var(--brand)_62%,transparent)]'
                      : 'border-transparent text-foreground/80 hover:border-[color:color-mix(in_oklab,var(--border-strong)_52%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-3)_74%,transparent)]'
                  )}
                  onClick={() => selectItem(index)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[color:color-mix(in_oklab,var(--surface-3)_74%,transparent)]">
                      {iconMap[item.type]}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[12.5px] font-medium text-[var(--text-1)]">
                          {item.title ?? item.label}
                        </span>
                        {item.type === 'command' ? (
                          <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-emerald-600">
                            Quick
                          </span>
                        ) : null}
                        {item.type === 'agent' && item.meta ? (
                          <span className="rounded-full bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--brand)]">
                            {item.meta}
                          </span>
                        ) : null}
                      </div>
                      {item.subtitle ? (
                        <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-[var(--text-3)]">
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

        <div className="flex items-center justify-between border-t border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] px-4 py-2 text-[10px] text-[var(--text-3)]">
          <span>↑↓ 选择</span>
          <span>Enter 插入</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    )
  }
)

function getMentionSectionLabel(section: MentionItem['section']): string {
  if (section === 'capability') return '常用能力'
  if (section === 'agent') return 'Agents'
  if (section === 'file') return 'Files'
  if (section === 'plugin') return 'Plugins'
  return 'Workspace Skills'
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

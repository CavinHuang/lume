import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Search,
  ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  getEffectiveLumeConfig,
  updatePermissionsSection,
} from '@/lib/desktop-api/lume-config'
import {
  SYSTEM_TOOL_GROUPS,
  buildSystemToolRows,
  findSystemToolGroup,
  type SystemToolGroup,
  type SystemToolRow,
  isToolInGroup,
} from '@/components/skills/system-tools-state'
import { TOOL_METADATA, RISK_LEVEL_CONFIG, CATEGORY_CONFIG } from './tool-metadata'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
interface ToolRow {
  name: string
  label: string
  description: string
  category: string
  riskLevel: string
  enabled: boolean
  locked: boolean
  groupId: string
  groupLabel: string
}

export function ToolsSettings() {
  const [config, setConfig] = useState<{
    permissions?: { toolPolicy?: { deny?: string[] } }
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(SYSTEM_TOOL_GROUPS.map(g => g.id)))

  const loadConfig = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setConfig(await getEffectiveLumeConfig())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  const systemToolRows = useMemo(
    () => buildSystemToolRows(config?.permissions?.toolPolicy?.deny),
    [config?.permissions?.toolPolicy?.deny],
  )

  const rowMap = useMemo(() => {
    const map = new Map<string, SystemToolRow>()
    systemToolRows.forEach((row) => map.set(row.id, row))
    return map
  }, [systemToolRows])

  const toolRows = useMemo<ToolRow[]>(() => {
    const denySet = new Set(
      (config?.permissions?.toolPolicy?.deny ?? []).map((entry) => entry.trim()),
    )

    return SYSTEM_TOOL_GROUPS.flatMap((group) => {
      const groupRow = rowMap.get(group.id)
      const groupEnabled = groupRow?.enabled ?? !group.locked
      const groupLocked = group.locked

      return Object.values(TOOL_METADATA)
        .filter((tool) => {
          // Map tools to groups based on category and known group mappings
          return isToolInGroup(tool.name, group.id)
        })
        .map((tool) => {
          const toolName = tool.name
          // Check if this specific tool is denied
          const explicitlyDenied = denySet.has(toolName)
          const effectiveEnabled = groupEnabled && !explicitlyDenied && !groupLocked

          return {
            name: toolName,
            label: tool.label,
            description: tool.description,
            category: tool.category,
            riskLevel: tool.riskLevel,
            enabled: effectiveEnabled,
            locked: groupLocked,
            groupId: group.id,
            groupLabel: group.label,
          }
        })
    })
  }, [config, rowMap])

  const visibleToolRows = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return toolRows
    return toolRows.filter((tool) => {
      const haystack = `${tool.label} ${tool.description} ${tool.groupLabel} ${tool.category}`.toLowerCase()
      return haystack.includes(keyword)
    })
  }, [toolRows, query])

  // Group visible tools by groupId, preserving SYSTEM_TOOL_GROUPS order
  const groupedTools = useMemo(() => {
    const groups = new Map<string, { group: SystemToolGroup; tools: ToolRow[] }>()
    for (const group of SYSTEM_TOOL_GROUPS) {
      groups.set(group.id, { group, tools: [] })
    }
    for (const tool of visibleToolRows) {
      const entry = groups.get(tool.groupId)
      if (entry) {
        entry.tools.push(tool)
      }
    }
    return Array.from(groups.values()).filter((entry) => entry.tools.length > 0)
  }, [visibleToolRows])

  const toggleGroup = useCallback(
    async (groupId: string, enabled: boolean) => {
      const group = findSystemToolGroup(groupId as any)
      if (group.locked || !config) return
      setSavingId(`group-${groupId}`)
      setError(null)
      try {
        const nextPermissions = buildGroupPermissions(config.permissions ?? {}, group, enabled)
        setConfig(await updatePermissionsSection(nextPermissions))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setSavingId(null)
      }
    },
    [config],
  )

  const toggleTool = useCallback(
    async (toolName: string, enabled: boolean) => {
      if (!config) return
      setSavingId(toolName)
      setError(null)
      try {
        const currentDeny = config.permissions?.toolPolicy?.deny ?? []
        let nextDeny: string[]
        if (enabled) {
          // Enable: remove tool name from deny list
          nextDeny = currentDeny.filter((entry) => entry.trim() !== toolName)
        } else {
          // Disable: add tool name to deny list
          nextDeny = [...currentDeny.filter((entry) => entry.trim() !== toolName), toolName]
        }
        const nextPermissions = {
          ...config.permissions,
          toolPolicy: { deny: nextDeny },
        }
        setConfig(await updatePermissionsSection(nextPermissions))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setSavingId(null)
      }
    },
    [config],
  )

  const toggleGroupExpanded = useCallback((groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) {
        next.delete(groupId)
      } else {
        next.add(groupId)
      }
      return next
    })
  }, [])

  const enabledCount = useMemo(
    () => toolRows.filter((t) => t.enabled).length,
    [toolRows],
  )
  const totalCount = toolRows.length

  return (
    <section className="flex min-h-0 flex-col">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[22px] font-semibold leading-7 text-[var(--text-1)]">工具管理</h2>
          <p className="mt-1 text-[13px] leading-5 text-[var(--text-2)]">
            管理 Lume 可使用的内置工具。已启用 {enabledCount}/{totalCount} 个工具。
            锁定工具为核心能力，不允许关闭。
          </p>
        </div>
      </div>

      {/* Search */}
      <label className="lume-panel mb-4 flex h-10 items-center gap-3 px-4 text-[var(--text-2)]">
        <Search size={18} />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索工具名称、描述或类别..."
          className="h-full min-w-0 flex-1 border-0 bg-transparent px-0 text-[13px] font-medium text-[var(--text-1)] shadow-none outline-none placeholder:text-[var(--text-3)] focus-visible:ring-0"
        />
      </label>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-[8px] border border-[color:color-mix(in_oklab,var(--lume-danger)_34%,var(--border))] bg-[color:color-mix(in_oklab,var(--lume-danger)_7%,var(--surface-1))] p-4 text-[13px] text-[var(--lume-danger)]">
          {error}
        </div>
      )}

      {/* Tool Groups */}
      {loading ? (
        <div className="lume-panel flex h-[200px] items-center justify-center gap-2 text-[13px] text-[var(--text-2)]">
          <Loader2 size={16} className="animate-spin" />
          正在读取工具...
        </div>
      ) : groupedTools.length === 0 ? (
        <div className="lume-subpanel border-dashed p-8 text-center text-[13px] text-[var(--text-2)]">
          没有匹配的工具。
        </div>
      ) : (
        <div className="grid gap-3">
          {groupedTools.map(({ group, tools }) => {
            const groupRow = rowMap.get(group.id)
            const groupEnabled = groupRow?.enabled ?? !group.locked
            const isExpanded = expandedGroups.has(group.id)
            const enabledInGroup = tools.filter((t) => t.enabled).length

            return (
              <div
                key={group.id}
                className={cn(
                  'rounded-[10px] border transition-colors',
                  groupEnabled
                    ? 'border-[var(--border)] bg-[var(--surface-1)]'
                    : 'border-[#f0d0d0] bg-[#fef8f8]',
                )}
              >
                {/* Group Header */}
                <div className="flex items-center gap-3 px-4 py-3">
                  <Button
                variant="ghost"
                    type="button"
                    onClick={() => toggleGroupExpanded(group.id)}
                    className="flex size-6 items-center justify-center rounded-[4px] text-[var(--text-2)] hover:bg-[var(--surface-2)]"
                  >
                    {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </Button>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[14px] font-semibold text-[var(--text-1)]">{group.label}</h3>
                      <span className="text-[12px] text-[var(--text-3)]">
                        {enabledInGroup}/{tools.length} 已启用
                      </span>
                      {group.locked && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[#f0f0f0] px-2 py-0.5 text-[11px] font-medium text-[#6b7280]">
                          <ShieldCheck size={11} />
                          锁定
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[12px] text-[var(--text-3)]">{group.description}</p>
                  </div>

                  {!group.locked && (
                    <Button
                variant="ghost"
                      type="button"
                      aria-label={`${groupEnabled ? '禁用' : '启用'}${group.label}`}
                      aria-pressed={groupEnabled}
                      disabled={savingId === `group-${group.id}`}
                      onClick={() => toggleGroup(group.id, !groupEnabled)}
                      className={cn(
                        'relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:cursor-wait disabled:opacity-65',
                        groupEnabled ? 'bg-[var(--brand)]' : 'bg-[var(--surface-3)]',
                      )}
                    >
                      {savingId === `group-${group.id}` ? (
                        <Loader2 size={14} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 animate-spin text-[var(--brand-foreground)]" />
                      ) : (
                        <span
                          className={cn(
                            'absolute top-1 size-5 rounded-full bg-white shadow transition-transform',
                            groupEnabled ? 'translate-x-6' : 'translate-x-1',
                          )}
                        />
                      )}
                    </Button>
                  )}
                </div>

                {/* Tool Rows */}
                {isExpanded && (
                  <div className="border-t border-[var(--border)]">
                    {tools.map((tool) => (
                      <ToolRowItem
                        key={tool.name}
                        tool={tool}
                        saving={savingId === tool.name}
                        onToggle={() => toggleTool(tool.name, !tool.enabled)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Footer note */}
      <p className="mt-5 text-[12px] leading-5 text-[var(--text-3)]">
        禁用工具后，模型将无法在对话中调用该工具。MCP 工具请在「MCP」设置中管理。
      </p>
    </section>
  )
}

function ToolRowItem({
  tool,
  saving,
  onToggle,
}: {
  tool: ToolRow
  saving: boolean
  onToggle: () => void
}) {
  const riskConfig = RISK_LEVEL_CONFIG[tool.riskLevel as keyof typeof RISK_LEVEL_CONFIG]
  const categoryConfig = CATEGORY_CONFIG[tool.category as keyof typeof CATEGORY_CONFIG]

  return (
    <div
      className={cn(
        'grid min-h-[52px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 transition-colors',
        tool.enabled ? '' : 'bg-[#fef8f8]/50',
      )}
    >
      <div className="size-5 shrink-0" />
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-medium text-[var(--text-1)]">{tool.label}</span>
          <span className="font-mono text-[11px] text-[var(--text-3)]">{tool.name}</span>
          {categoryConfig && (
            <span className="rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-[11px] text-[var(--text-3)]">
              {categoryConfig.icon} {categoryConfig.label}
            </span>
          )}
          {riskConfig && (
            <span
              className={cn('rounded-full px-1.5 py-0.5 text-[11px] font-medium', riskConfig.className)}
            >
              {riskConfig.label}风险
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[12px] text-[var(--text-3)]">{tool.description}</p>
      </div>
      <div className="flex min-w-[88px] items-center justify-end gap-2">
        {tool.locked ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-[#6b7280]">
            <ShieldCheck size={12} />
            锁定
          </span>
        ) : (
          <Button
                variant="ghost"
            type="button"
            aria-label={`${tool.enabled ? '禁用' : '启用'}${tool.label}`}
            aria-pressed={tool.enabled}
            disabled={saving}
            onClick={onToggle}
            className={cn(
              'relative h-6 w-11 rounded-full transition-colors disabled:cursor-wait disabled:opacity-65',
              tool.enabled ? 'bg-[var(--brand)]' : 'bg-[var(--surface-3)]',
            )}
          >
            {saving ? (
              <Loader2 size={12} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 animate-spin text-[var(--brand-foreground)]" />
            ) : (
              <span
                className={cn(
                  'absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform',
                  tool.enabled ? 'translate-x-5' : 'translate-x-0.5',
                )}
              />
            )}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * 构建权限配置更新
 */
function buildGroupPermissions(
  current: { toolPolicy?: { deny?: string[] } } = {},
  group: SystemToolGroup,
  enabled: boolean,
) {
  if (group.locked || !group.policyEntry) return current
  const toolPolicy = current.toolPolicy ?? {}
  const currentDeny = toolPolicy.deny ?? []

  let nextDeny: string[]
  if (enabled) {
    // 启用：移除 policyEntry
    nextDeny = currentDeny.filter((entry) => entry.trim() !== group.policyEntry)
  } else {
    // 禁用：添加 policyEntry
    nextDeny = [...currentDeny.filter((entry) => entry.trim() !== group.policyEntry), group.policyEntry]
  }

  return {
    ...current,
    toolPolicy: {
      ...toolPolicy,
      deny: nextDeny,
    },
  }
}

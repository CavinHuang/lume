import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Loader2, Plus, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type {
  LumeConfigPermissionRuleAction,
  LumeConfigPermissionsSection,
  LumeEffectiveConfig,
} from '@lume/shared'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  getEffectiveLumeConfig,
  updateAgentPermissionMode,
  updatePermissionsSection,
} from '@/lib/desktop-api/lume-config'
import {
  buildPermissionScopeOptions,
  buildPermissionSettingsDraft,
  createPermissionRuleDraft,
  formatPermissionScopeLabel,
  GLOBAL_PERMISSION_SCOPE_VALUE,
  normalizePermissionRuleDrafts,
  PERMISSION_MODE_OPTIONS,
  type PermissionRuleDraft,
  type PermissionSettingsDraft,
} from './permission-settings-state'

type SavingTarget = null | 'settings'

const RULE_ACTION_OPTIONS: Array<{
  value: LumeConfigPermissionRuleAction
  label: string
}> = [
  { value: 'allow', label: 'Allow（始终允许）' },
  { value: 'ask', label: 'Ask（每次确认）' },
  { value: 'deny', label: 'Deny（始终拒绝）' },
]

export function PermissionSettings() {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const currentWorkspace = React.useMemo(
    () => workspaces.find((item) => item.id === currentWorkspaceId) ?? workspaces[0] ?? null,
    [currentWorkspaceId, workspaces]
  )
  const scopeOptions = React.useMemo(() => buildPermissionScopeOptions(workspaces), [workspaces])
  const [scopeValue, setScopeValue] = React.useState(GLOBAL_PERMISSION_SCOPE_VALUE)
  const initializedScopeRef = React.useRef(false)
  const [config, setConfig] = React.useState<LumeEffectiveConfig | null>(null)
  const [draft, setDraft] = React.useState<PermissionSettingsDraft | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState<SavingTarget>(null)

  const selectedWorkspaceSlug = scopeValue === GLOBAL_PERMISSION_SCOPE_VALUE ? undefined : scopeValue
  const selectedWorkspace = React.useMemo(
    () => selectedWorkspaceSlug
      ? workspaces.find((workspace) => workspace.slug === selectedWorkspaceSlug) ?? null
      : null,
    [selectedWorkspaceSlug, workspaces]
  )
  const scopeLabel = formatPermissionScopeLabel(scopeOptions, scopeValue)

  const reload = React.useCallback(async () => {
    setLoading(true)
    const nextConfig = await getEffectiveLumeConfig(selectedWorkspaceSlug)
    setConfig(nextConfig)
    setDraft(buildPermissionSettingsDraft(nextConfig))
  }, [selectedWorkspaceSlug])

  React.useEffect(() => {
    if (initializedScopeRef.current || !currentWorkspace?.slug) return
    initializedScopeRef.current = true
    setScopeValue(currentWorkspace.slug)
  }, [currentWorkspace?.slug])

  React.useEffect(() => {
    if (scopeValue === GLOBAL_PERMISSION_SCOPE_VALUE) return
    if (scopeOptions.some((option) => option.value === scopeValue)) return
    setScopeValue(GLOBAL_PERMISSION_SCOPE_VALUE)
  }, [scopeOptions, scopeValue])

  React.useEffect(() => {
    let cancelled = false
    reload()
      .catch((error) => {
        console.error('[PermissionSettings] load FAILED:', error)
        toast.error('加载权限设置失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [reload])

  const updateDraft = (patch: Partial<PermissionSettingsDraft>) => {
    setDraft((current) => current ? { ...current, ...patch } : current)
  }

  const updateRule = (index: number, patch: Partial<PermissionRuleDraft>) => {
    setDraft((current) => {
      if (!current) return current
      const rules = current.rules.map((rule, ruleIndex) =>
        ruleIndex === index ? { ...rule, ...patch } : rule
      )
      return { ...current, rules }
    })
  }

  const addRule = () => {
    setDraft((current) => current
      ? { ...current, rules: [...current.rules, createPermissionRuleDraft()] }
      : current
    )
  }

  const removeRule = (index: number) => {
    setDraft((current) => current
      ? { ...current, rules: current.rules.filter((_, ruleIndex) => ruleIndex !== index) }
      : current
    )
  }

  const savePermissionSettings = async () => {
    if (!config || !draft) return
    setSaving('settings')
    try {
      const afterMode = await updateAgentPermissionMode(draft.permissionMode, selectedWorkspaceSlug)
      const basePermissions = afterMode.permissions ?? config.permissions ?? {}
      const nextPermissions: LumeConfigPermissionsSection = {
        ...basePermissions,
        toolPolicy: { allow: [], deny: [] },
        rules: normalizePermissionRuleDrafts(draft.rules),
      }
      const nextConfig = await updatePermissionsSection(nextPermissions, selectedWorkspaceSlug)
      setConfig(nextConfig)
      setDraft(buildPermissionSettingsDraft(nextConfig))
      toast.success(`权限设置已保存到 ${scopeLabel}`)
    } catch (error) {
      console.error('[PermissionSettings] save settings FAILED:', error)
      toast.error('保存权限设置失败')
    } finally {
      setSaving(null)
    }
  }

  if (loading || !draft) {
    return (
      <div className="flex h-[280px] items-center justify-center rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] text-[13px] text-[var(--text-3)]">
        <Loader2 size={14} className="mr-2 animate-spin" />
        加载权限设置...
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-[var(--text-1)]">配置作用域</div>
          <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">
            {selectedWorkspace ? `正在编辑工作区覆盖: ${selectedWorkspace.name} (${selectedWorkspace.slug})` : '正在编辑所有工作区共享的全局默认权限'}
          </p>
        </div>
        <label className="flex min-w-[260px] max-w-full items-center gap-2 text-[12px] font-medium text-[var(--text-2)]">
          作用域
          <select
            value={scopeValue}
            onChange={(event) => setScopeValue(event.target.value)}
            className="h-9 min-w-0 flex-1 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-[13px] text-[var(--text-1)] outline-none"
          >
            {scopeOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </section>

      <SettingsCard
        title="权限模式"
        description="控制 Agent 执行工具时是否需要用户确认。"
      >
        <div className="rounded-[8px] bg-[var(--surface-2)] p-2">
          {PERMISSION_MODE_OPTIONS.map((option) => {
            const selected = draft.permissionMode === option.value
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => updateDraft({ permissionMode: option.value })}
                className={cn(
                  'flex w-full items-start gap-3 rounded-[8px] px-3 py-3 text-left transition-colors',
                  selected ? 'bg-[var(--surface-1)] text-[var(--text-1)] shadow-[0_1px_2px_rgba(20,24,40,0.04)]' : 'text-[var(--text-2)] hover:bg-[color-mix(in_oklab,var(--surface-1)_70%,transparent)]'
                )}
              >
                <span
                  className={cn(
                    'mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                    selected ? 'border-[var(--text-1)]' : 'border-[var(--text-3)]'
                  )}
                >
                  {selected && <span className="h-2 w-2 rounded-full bg-[var(--text-1)]" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[14px] font-semibold">{option.label}</span>
                  <span className="mt-1 block text-[12px] leading-5 text-[var(--text-3)]">
                    {option.description}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </SettingsCard>

      <SettingsCard
        title="权限规则"
        description="规则按顺序匹配，首条命中的规则生效。可用于给特定工具、命令或路径设置 Allow / Ask / Deny。"
      >
        <div className="overflow-x-auto">
          <div className="min-w-[780px] space-y-2">
            <div className="grid grid-cols-[150px_minmax(120px,1fr)_minmax(190px,1.2fr)_minmax(170px,1fr)_36px] gap-2 px-1 text-[11px] font-medium text-[var(--text-3)]">
              <span>策略</span>
              <span>工具</span>
              <span>命令正则（可选）</span>
              <span>路径模式（可选）</span>
              <span />
            </div>
            {draft.rules.length === 0 ? (
              <div className="rounded-[8px] border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-3 py-6 text-center text-[13px] text-[var(--text-3)]">
                暂无权限规则
              </div>
            ) : (
              draft.rules.map((rule, index) => (
                <div
                  key={`${rule.id ?? 'rule'}-${index}`}
                  className="grid grid-cols-[150px_minmax(120px,1fr)_minmax(190px,1.2fr)_minmax(170px,1fr)_36px] gap-2"
                >
                  <select
                    value={rule.action}
                    onChange={(event) => updateRule(index, { action: event.target.value as LumeConfigPermissionRuleAction })}
                    className="h-9 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-[13px] text-[var(--text-1)] outline-none"
                  >
                    {RULE_ACTION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <input
                    value={rule.tool}
                    onChange={(event) => updateRule(index, { tool: event.target.value })}
                    placeholder="bash"
                    className="h-9 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-[13px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
                  />
                  <input
                    value={rule.commandPattern}
                    onChange={(event) => updateRule(index, { commandPattern: event.target.value })}
                    placeholder="npm\\s+install"
                    className="h-9 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-[13px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
                  />
                  <input
                    value={rule.pathPattern}
                    onChange={(event) => updateRule(index, { pathPattern: event.target.value })}
                    placeholder="src/**"
                    className="h-9 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-[13px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 rounded-[8px] text-[var(--text-3)] hover:text-red-600"
                    aria-label="删除权限规则"
                    onClick={() => removeRule(index)}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-9 rounded-[8px]"
            onClick={addRule}
          >
            <Plus size={14} />
            添加规则
          </Button>
          <Button
            type="button"
            className="h-9 rounded-[8px]"
            disabled={saving === 'settings'}
            onClick={() => void savePermissionSettings()}
          >
            {saving === 'settings' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            保存
          </Button>
        </div>
      </SettingsCard>
    </div>
  )
}

function SettingsCard({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] p-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <div className="mb-4">
        <h3 className="text-[16px] font-semibold text-[var(--text-1)]">{title}</h3>
        {description && <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">{description}</p>}
      </div>
      {children}
    </section>
  )
}

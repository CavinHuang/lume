import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Check, Loader2, Map, Pencil, Plus, Save, Shield, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type {
  LumeConfigPermissionRuleAction,
  LumeEffectiveConfig,
  AgentToolPermissionGrantRecord,
} from '@lume/shared'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  getEffectiveLumeConfig,
  updateAgentPermissionMode,
  updateAgentProjectInstructionsEnabled,
  updatePermissionClassifierEnabled,
  updatePermissionsSection,
} from '@/lib/desktop-api/lume-config'
import {
  PERMISSION_OPTIONS,
  TONE_CLASS,
  type PermissionModeIconKey,
  type PermissionOption,
} from '@/components/settings/agent-settings-state'
import {
  buildPermissionScopeOptions,
  buildPermissionsSectionFromRuleDrafts,
  buildPermissionSettingsDraft,
  createPermissionRuleDraft,
  formatPermissionScopeLabel,
  GLOBAL_PERMISSION_SCOPE_VALUE,
  type PermissionRuleDraft,
  type PermissionSettingsDraft,
} from './permission-settings-state'

import { Input } from '@/components/ui/input'
import {
  listToolPermissionGrants,
  revokeToolPermissionGrants,
} from '@/lib/desktop-api/tool-permission-grants'
import { ToolPermissionGrantsCard } from './ToolPermissionGrantsCard'
const ICON_MAP: Record<PermissionModeIconKey, typeof Shield> = {
  shield: Shield,
  pencil: Pencil,
  'shield-check': ShieldCheck,
  'shield-off': ShieldOff,
  map: Map,
}

type SavingTarget = null | 'mode' | 'rules' | 'projectInstructions' | 'classifier'

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

  // #775：「始终允许」workspace 级持久授权（查看/撤销）
  const [toolGrants, setToolGrants] = React.useState<AgentToolPermissionGrantRecord[]>([])
  const reloadToolGrants = React.useCallback(async () => {
    try {
      const { grants } = await listToolPermissionGrants()
      setToolGrants(grants)
    } catch (error) {
      console.error('[PermissionSettings] load tool grants FAILED:', error)
      toast.error('加载已授予的工具权限失败')
    }
  }, [])

  React.useEffect(() => {
    void reloadToolGrants()
  }, [reloadToolGrants])

  const visibleToolGrants = React.useMemo(
    () => selectedWorkspaceSlug
      ? toolGrants.filter((grant) => grant.workspaceSlug === selectedWorkspaceSlug)
      : toolGrants,
    [selectedWorkspaceSlug, toolGrants],
  )

  const handleRevokeToolGrant = async (id: string) => {
    try {
      await revokeToolPermissionGrants({ ids: [id] })
      toast.success('已撤销该授权')
    } catch (error) {
      console.error('[PermissionSettings] revoke tool grant FAILED:', error)
      toast.error('撤销授权失败')
    } finally {
      void reloadToolGrants()
    }
  }

  const handleClearWorkspaceToolGrants = async () => {
    if (!selectedWorkspaceSlug) return
    try {
      const { removed } = await revokeToolPermissionGrants({ workspaceSlug: selectedWorkspaceSlug })
      toast.success(`已清空 ${removed} 条授权`)
    } catch (error) {
      console.error('[PermissionSettings] clear workspace tool grants FAILED:', error)
      toast.error('清空授权失败')
    } finally {
      void reloadToolGrants()
    }
  }

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

  const handlePermissionModeChange = async (value: PermissionOption['value']) => {
    if (!draft || draft.permissionMode === value) return
    setDraft((current) => current ? { ...current, permissionMode: value } : current)
    setSaving('mode')
    try {
      const nextConfig = await updateAgentPermissionMode(value, selectedWorkspaceSlug)
      setConfig(nextConfig)
      setDraft(buildPermissionSettingsDraft(nextConfig))
    } catch (error) {
      console.error('[PermissionSettings] save mode FAILED:', error)
      toast.error('保存权限模式失败')
    } finally {
      setSaving(null)
    }
  }

  // #670 行为告知:项目指令(CLAUDE.md/AGENTS.md)自动注入开关,缺省开启。
  const projectInstructionsEnabled = config?.agent?.projectInstructionsEnabled !== false
  const handleProjectInstructionsEnabledChange = async (enabled: boolean) => {
    setSaving('projectInstructions')
    try {
      const nextConfig = await updateAgentProjectInstructionsEnabled(enabled, selectedWorkspaceSlug)
      setConfig(nextConfig)
    } catch (error) {
      console.error('[PermissionSettings] save project instructions FAILED:', error)
      toast.error('保存项目指令设置失败')
    } finally {
      setSaving(null)
    }
  }

  const handleClassifierEnabledChange = async (value: boolean) => {
    setSaving('classifier')
    try {
      const nextConfig = await updatePermissionClassifierEnabled(value, selectedWorkspaceSlug)
      setConfig(nextConfig)
      setDraft(buildPermissionSettingsDraft(nextConfig))
      toast.success(`风险分类器设置已保存到 ${scopeLabel}`)
    } catch (error) {
      console.error('[PermissionSettings] save classifier FAILED:', error)
      toast.error('保存风险分类器设置失败')
    } finally {
      setSaving(null)
    }
  }

  const savePermissionSettings = async () => {
    if (!config || !draft) return
    setSaving('rules')
    try {
      const basePermissions = config.permissions ?? {}
      const nextPermissions = buildPermissionsSectionFromRuleDrafts(basePermissions, draft.rules)
      const nextConfig = await updatePermissionsSection(nextPermissions, selectedWorkspaceSlug)
      setConfig(nextConfig)
      setDraft(buildPermissionSettingsDraft(nextConfig))
      toast.success(`权限规则已保存到 ${scopeLabel}`)
    } catch (error) {
      console.error('[PermissionSettings] save rules FAILED:', error)
      toast.error('保存权限规则失败')
    } finally {
      setSaving(null)
    }
  }

  if (loading || !draft) {
    return (
      <div className="lume-panel flex h-[280px] items-center justify-center text-[13px] text-[var(--text-3)]">
        <Loader2 size={14} className="mr-2 animate-spin" />
        加载权限设置...
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <section className="lume-panel flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-[var(--text-1)]">配置作用域</div>
          <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">
            {selectedWorkspace ? `正在编辑工作区覆盖: ${selectedWorkspace.name} (${selectedWorkspace.slug})` : '正在编辑所有工作区共享的全局默认权限'}
          </p>
        </div>
        <label className="flex min-w-[260px] max-w-full items-center gap-2 text-[12px] font-medium text-[var(--text-2)]">
          作用域
          <Select
            value={scopeValue}
            onValueChange={(value) => { if (value) setScopeValue(value) }}
          >
            <SelectTrigger className="h-9 min-w-0 flex-1 border-[var(--border)] bg-[var(--surface-1)] px-3 text-[13px] text-[var(--text-1)] shadow-none focus-visible:ring-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
            {scopeOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
            </SelectContent>
          </Select>
        </label>
      </section>

      <SettingsCard
        title="权限模式"
        description="控制 Agent 执行工具时是否需要用户确认。"
      >
        <div className="space-y-1">
          {PERMISSION_OPTIONS.map((option) => {
            const selected = draft.permissionMode === option.value
            const Icon = ICON_MAP[option.icon]
            return (
              <Button
                variant="ghost"
                key={option.value}
                type="button"
                onClick={() => void handlePermissionModeChange(option.value)}
                className={cn(
                  'lume-subpanel flex h-auto min-h-[52px] w-full items-center justify-start gap-2.5 px-2.5 py-2 text-left whitespace-normal transition-colors',
                  selected
                    ? 'border-[color:color-mix(in_oklab,var(--brand)_34%,var(--border-strong))] bg-[color:color-mix(in_oklab,var(--brand)_8%,var(--surface-1))]'
                    : 'hover:bg-[var(--surface-1)]',
                )}
              >
                <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full border', TONE_CLASS[option.tone])}>
                  <Icon size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-[12.5px] font-medium text-[var(--text-1)]">{option.label}</span>
                    <span className={cn('rounded-full border px-1.5 py-0.5 text-[9.5px] font-medium', TONE_CLASS[option.tone])}>
                      {option.emphasis}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-[var(--text-3)]">{option.desc}</span>
                </span>
                {selected && <Check size={14} className="shrink-0 text-[var(--brand)]" />}
              </Button>
            )
          })}
        </div>
      </SettingsCard>

      <SettingsCard
        title="风险分类器"
        description="「少询问」依据内置窄正则词表判定低风险并自动放行，「默认」档不做词表驱动的放行——两档审批差异由这张词表决定。"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-body font-medium text-[var(--text-1)]">启发式风险分类</div>
            <p className="mt-1 text-ui leading-5 text-[var(--text-3)]">
              关闭后不再有任何词表自动放行，白名单外命令逐条确认；工具声明的低风险豁免与可证只读免审不受影响。
            </p>
          </div>
          <Switch
            checked={config?.permissions?.classifier?.enabled !== false}
            disabled={saving !== null}
            onCheckedChange={(checked) => void handleClassifierEnabledChange(checked)}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="项目指令"
        description="自动加载项目目录中的 CLAUDE.md / AGENTS.md 注入 Agent 系统提示（就近向上解析，单文件超 32KB 截断）。会话头部会显示当前生效的指令文件。"
      >
        <div className="flex items-center justify-between gap-3 py-1">
          <div className="min-w-0">
            <div className="text-ui font-medium text-[var(--text-1)]">项目指令自动注入</div>
            <div className="mt-0.5 text-caption text-[var(--text-3)]">关闭后不读取项目指令文件</div>
          </div>
          <Switch
            checked={projectInstructionsEnabled}
            disabled={saving !== null}
            onCheckedChange={(checked) => void handleProjectInstructionsEnabledChange(checked)}
          />
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
                  <Select
                    value={rule.action}
                    onValueChange={(value) => { if (value) updateRule(index, { action: value as LumeConfigPermissionRuleAction }) }}
                  >
                    <SelectTrigger className="h-9 w-full border-[var(--border)] bg-[var(--surface-1)] px-3 text-[13px] text-[var(--text-1)] shadow-none focus-visible:ring-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                    {RULE_ACTION_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={rule.tool}
                    onChange={(event) => updateRule(index, { tool: event.target.value })}
                    placeholder="bash"
                    className="h-9 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-[13px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
                  />
                  <Input
                    value={rule.commandPattern}
                    onChange={(event) => updateRule(index, { commandPattern: event.target.value })}
                    placeholder="npm\\s+install"
                    className="h-9 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-[13px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
                  />
                  <Input
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
            disabled={saving === 'rules'}
            onClick={() => void savePermissionSettings()}
          >
            {saving === 'rules' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            保存规则
          </Button>
        </div>
      </SettingsCard>

      <ToolPermissionGrantsCard
        grants={visibleToolGrants}
        workspaceSlug={selectedWorkspaceSlug}
        onRevokeGrant={(id) => void handleRevokeToolGrant(id)}
        onClearWorkspace={() => void handleClearWorkspaceToolGrants()}
      />
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
    <section className="lume-panel-padded">
      <div className="mb-4">
        <h3 className="text-[16px] font-semibold text-[var(--text-1)]">{title}</h3>
        {description && <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">{description}</p>}
      </div>
      {children}
    </section>
  )
}

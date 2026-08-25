import type {
  AgentWorkspace,
  LumeConfigPermissionMode,
  LumeConfigPermissionRule,
  LumeConfigPermissionRuleAction,
  LumeConfigPermissionRuleScope,
  LumeConfigPermissionsSection,
  LumeEffectiveConfig,
} from '@lume/shared'

export const GLOBAL_PERMISSION_SCOPE_VALUE = '__global__'

export interface PermissionScopeOption {
  value: string
  label: string
  description: string
}

export interface PermissionRuleDraft {
  id?: string
  action: LumeConfigPermissionRuleAction
  tool: string
  commandPattern: string
  pathPattern: string
  scope?: LumeConfigPermissionRuleScope
}

export interface PermissionSettingsDraft {
  permissionMode: LumeConfigPermissionMode
  rules: PermissionRuleDraft[]
}

export const PERMISSION_MODE_OPTIONS: Array<{
  value: LumeConfigPermissionMode
  label: string
  description: string
}> = [
  { value: 'default', label: '默认模式', description: '写入与执行类操作需要确认，可证只读的命令免审。' },
  { value: 'plan', label: 'Plan 模式', description: '只允许分析和规划，禁止工具执行。' },
  { value: 'acceptEdits', label: '接受编辑', description: '文件读写与只读命令自动放行，其余命令仍需确认。' },
  { value: 'dontAsk', label: '少打扰模式（推荐）', description: '危险命令自动拒绝，安全操作自动放行。' },
  { value: 'bypassPermissions', label: '完全自动', description: '确认类操作自动放行，硬危险操作仍会拦截。' },
]

export function buildPermissionScopeOptions(workspaces: AgentWorkspace[]): PermissionScopeOption[] {
  return [
    {
      value: GLOBAL_PERMISSION_SCOPE_VALUE,
      label: '全局默认',
      description: '所有工作区的基础权限',
    },
    ...workspaces.map((workspace) => ({
      value: workspace.slug,
      label: workspace.name,
      description: `工作区覆盖: ${workspace.slug}`,
    })),
  ]
}

export function formatPermissionScopeLabel(options: PermissionScopeOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value
}

export function createPermissionRuleDraft(
  patch: Partial<PermissionRuleDraft> = {}
): PermissionRuleDraft {
  return {
    action: 'ask',
    tool: '',
    commandPattern: '',
    pathPattern: '',
    scope: undefined,
    ...patch,
  }
}

function toPermissionRuleDraft(rule: LumeConfigPermissionRule): PermissionRuleDraft {
  return createPermissionRuleDraft({
    id: rule.id,
    action: rule.action,
    tool: rule.tool,
    commandPattern: rule.commandPattern ?? '',
    pathPattern: rule.pathPattern ?? '',
    scope: rule.scope,
  })
}

export function buildPermissionSettingsDraft(config: LumeEffectiveConfig): PermissionSettingsDraft {
  return {
    permissionMode: config.agent?.permissionMode ?? 'default',
    rules: (config.permissions?.rules ?? []).map(toPermissionRuleDraft),
  }
}

export function normalizePermissionRuleDrafts(
  rules: PermissionRuleDraft[]
): LumeConfigPermissionRule[] {
  const normalized: LumeConfigPermissionRule[] = []

  for (const rule of rules) {
    const tool = rule.tool.trim()
    if (!tool) continue

    const id = rule.id?.trim()
    const commandPattern = rule.commandPattern.trim()
    const pathPattern = rule.pathPattern.trim()
    const nextRule: LumeConfigPermissionRule = {
      action: rule.action,
      tool,
    }

    if (id) nextRule.id = id
    if (commandPattern) nextRule.commandPattern = commandPattern
    if (pathPattern) nextRule.pathPattern = pathPattern
    if (rule.scope) nextRule.scope = rule.scope

    normalized.push(nextRule)
  }

  return normalized
}

export function buildPermissionsSectionFromRuleDrafts(
  basePermissions: LumeConfigPermissionsSection = {},
  rules: PermissionRuleDraft[],
): LumeConfigPermissionsSection {
  return {
    ...basePermissions,
    rules: normalizePermissionRuleDrafts(rules),
  }
}

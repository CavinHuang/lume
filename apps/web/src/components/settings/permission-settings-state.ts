import type {
  AgentWorkspace,
  LumeConfigPermissionMode,
  LumeConfigPermissionRule,
  LumeConfigPermissionRuleAction,
  LumeConfigPermissionsSection,
  LumeEffectiveConfig,
} from '@lume/shared'

// #519：LumeConfigPermissionRule.scope 死字段已删除（判定逻辑从不读取作用域），
// 规则草稿同步摘除；下方 Scope Option 相关导出服务「保存到哪个工作区配置」选择器，与本字段无关。
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
}

export interface PermissionSettingsDraft {
  permissionMode: LumeConfigPermissionMode
  rules: PermissionRuleDraft[]
}

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
